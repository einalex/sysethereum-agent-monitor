const app = require('express')();
const cors = require('cors');

const nodemailer = require('nodemailer');
const os = require('os');

const config = require('./config');
const utils = require('./utils');
const constants = require('./constants');
const { stopAndRestart } = require('./processUtils');

let mailConfig = utils.configMailer(config);
let transporter = nodemailer.createTransport(mailConfig);
let checkInterval;
let isAttemptingRestart = false;
let agentStartTime = Date.now();

// see if we have existing uptime data
let uptime = utils.readFile(constants.UPTIME_FILE);
if(!isNaN(parseFloat(uptime))) {
  console.log('UPTIME:', uptime);
  // get current uptime and see if we've restarted
  if (os.uptime() < uptime) {
    utils.sendMail(transporter, require('./messages/agent_os_restarted'));
  }

  // update the uptime
  utils.writeFile(constants.UPTIME_FILE, os.uptime());
} else {
  uptime = os.uptime();
  utils.writeFile(constants.UPTIME_FILE, uptime);
  console.log('Writing initial uptime of ', uptime);
}

async function checkProcessStatuses(getRawProcessStatus) {
  let processStatus = {}, sysStatus = {}, ethStatus = {};
  processStatus = await utils.checkProcessDown();
  if (!processStatus.isError) {
    try {
      sysStatus = await utils.checkSyscoinChainTips();
      ethStatus = await utils.checkEthereumChainHeight();
    } catch (e) {
      console.log("Processes must be down, cannot get chain time info.");
    }
  }

  return getRawProcessStatus ? { processStatus, sysStatus, ethStatus, agentStartTime } : { ...processStatus, sysStatus, ethStatus, agentStartTime };
}

async function checkForAlerts(mailer, skipMail) {
  console.log('check alerts',config.enable_autorestart, isAttemptingRestart);
  const { processStatus, sysStatus, ethStatus } = await checkProcessStatuses(true);
  const statusResult = await checkProcessStatuses();

  console.log(processStatus.isError, sysStatus.isError, ethStatus.isError);
  if (config.enable_autorestart && !isAttemptingRestart && (processStatus.isError || sysStatus.isError || ethStatus.isError)) {
    clearInterval(checkInterval);
    isAttemptingRestart = true;
    console.log('Attempting restart!!!');
    let reason = {};
    if (processStatus.isError) {
      reason.text = 'One or more key processes (agent, syscoind, sysgeth, sysrelayer) has stopped unexpectedly. \\n';
      reason.html = 'One or more key processes (agent, syscoind, sysgeth, sysrelayer) has stopped unexpectedly. <br /><ul>';
      Object.keys(processStatus).forEach(key => {
        if (key !== 'isError') {
          reason.text += `${key}: ${processStatus[key]} \\n`;
          reason.html += `<li ${processStatus[key] === false ? `style=\\"color:red; font-weight: bold\\"` : ''}>${key}: ${processStatus[key]} </li>`;
        }
      });
      reason.html += '</ul>';
    } else if (sysStatus.isError) {
      reason = 'Syscoin full node is on wrong chain.';
    } else if (ethStatus.isError) {
      reason = 'Ethereum geth out of sync.';
    } else {
      reason = 'Cannot determine!';
    }
    const tokenObj = {
      text: reason.text,
      html: reason.html
    };

    agentStartTime = Date.now(); // update agent start time
    await utils.sendMail(mailer, require('./messages/agent_restart_in_progress'), tokenObj, true);
    const result = await stopAndRestart();

    if(result) {
      // restart worked
      let result = await checkProcessStatuses(true);
      if (!result.processStatus.isError && !result.sysStatus.isError && !result.ethStatus.isError) {
        console.log('seems like restart worked!');
        startCheckInterval();

        // notify human
        await utils.notifyOfRestartFail(mailer, true);
      } else {
        isAttemptingRestart = false;
        console.log("Something went wrong validating restart.");
        config.enable_autorestart = false; //disable autorestart until a human comes and helps

        //message the human
        await utils.notifyOfRestartFail(mailer, false);

        //restart the checker so that they keep getting messages until they fix it
        startCheckInterval();
      }
    } else {
      isAttemptingRestart = false;
      console.log("Something went wrong with restart general.");

      //message the human
      await utils.notifyOfRestartFail(mailer, false);

      //restart the checker so that they keep getting messages until they fix it
      startCheckInterval();
    }

  } else if (!skipMail) {
    if (isAttemptingRestart) {
      isAttemptingRestart = false;
    }

    if (config.enable_mail && processStatus.isError) {
      let processName;
      Object.keys(processStatus).forEach(key => {
        if(key !== 'isError' && !processStatus[key]) {
          processName = key;
        }
      });
      let info = await utils.sendMail(mailer, require('./messages/agent_process_down'));
      console.log(`${processName.toUpperCase()} DOWN! Sending email. ${info}`);
      return;
    }

    if (config.enable_mail && sysStatus.isError) {
      const tokenObj = {
        local: JSON.stringify(sysStatus.local),
        remote: JSON.stringify(sysStatus.remote)
      };
      await utils.sendMail(mailer, require('./messages/agent_sys_chain_mismatch'), tokenObj);
      return;
    }

    if (config.enable_mail && ethStatus.isError) {
      const tokenObj = {
        local: JSON.stringify(ethStatus.local),
        remote: JSON.stringify(ethStatus.remote)
      };
      await utils.sendMail(mailer, require('./messages/agent_eth_chain_height'), tokenObj);
      return;
    }
  }

  return statusResult;
}

function startCheckInterval() {
  // passive status checking
  checkInterval = setInterval(checkForAlerts, config.interval * 1000, transporter);
}

startCheckInterval();

// webserver for proactive checks
app.use(cors());
app.get('/status', async (req, res) => {
  console.log("Http ping");
  const status = await checkProcessStatuses(false);

  return res.send({ ...status});
});

app.listen(config.port);
console.log(`Sysethereum agent monitor started with config ${JSON.stringify(config)}`);

