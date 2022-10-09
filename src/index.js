import { homedir } from "os"
import fs from "fs"
import path from "path"
import * as core from "@actions/core"
import * as github from "@actions/github"
import { Octokit } from "@octokit/rest"
const { createActionAuth } = require("@octokit/auth-action");
const util = require('util');
const process = require('process');
const SSHConfig = require('ssh-config')
const glob = require("glob");

import { execShellCommand } from "./helpers"

const UPTERM_VERSION = "v0.9.0"

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function handle_signal(signal) {
  core.warning(`received ${signal}, exiting.`);
  process.exit(0);
}


export async function run() {
  process.on('SIGINT', handle_signal);
  process.on('SIGHUP', handle_signal);
  process.on('SIGTERM', handle_signal);
  process.on('SIGUSR1', handle_signal);

  const homeDir = homedir();

  try {
    if (process.platform === "win32") {
      core.error("Windows is not supported by upterm, skipping...")
      return
    }


    core.debug("Installing dependencies")
    if (process.platform == "linux") {
      try {
        await execShellCommand(`upterm version`);
        core.debug("upterm is already installed.");
      } catch {
        core.debug("Installing upterm");
        await execShellCommand(`curl -sL https://github.com/owenthereal/upterm/releases/download/${UPTERM_VERSION}/upterm_linux_amd64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/`);
      }
      try {
        await execShellCommand(`tmux -V`);
        core.debug("tmux is already installed.");
      } catch {
        core.debug("Installing upterm");
        await execShellCommand("sudo apt-get -y install tmux");
      }
    } else {
      process.env.HOMEBREW_NO_INSTALL_CLEANUP = "true";
      await execShellCommand("brew install owenthereal/upterm/upterm");
      await execShellCommand("brew install tmux");
    }
    core.debug("Installed dependencies successfully");

    const home = process.env.HOME;

    // clean up any pre-existing upterm sockets
    const uptermSockGlob = path.join(homeDir, ".upterm/*.sock");
    glob(uptermSockGlob, [], function (er, files) {
      files.forEach((file => {
        try {
          globfs.rmSync(file)
        } catch (error) {
          core.warning(`error removing ${file}`)
        }
      }))
    });

    // make sure we have a BASH
    if (process.env.SHELL == undefined || !process.env.SHELL.endsWith("bash")) {
      const fallbackShell = "/bin/bash";
      core.debug(`setting SHELL to ${fallbackShell}`);
      process.env.SHELL = fallbackShell;
    }

    if (process.env.TMUX_TMPDIR == undefined) {
      const tmuxTmpdirFallback = `${home}/.tmux_tmpdir`;
      core.debug(`setting TMUX_TMPDIR=${tmuxTmpdirFallback}`);
      process.env.TMUX_TMPDIR = tmuxTmpdirFallback;
    };
    fs.mkdirSync(process.env.TMUX_TMPDIR, { recursive: true });

    const sshPath = path.join(homeDir, ".ssh")
    if (!fs.existsSync(sshPath)) {
      core.debug(`Creating ${sshPath}`);
      fs.mkdirSync(sshPath, { recursive: true });
    };

    for (const t of [
      { id_file: "id_rsa", algo: "rsa" },
      { id_file: "id_ed25519", algo: "ed25519" }
    ]) {
      if (!fs.existsSync(path.join(sshPath, t.id_file))) {
        core.debug(util.format(`Generating %s SSH key at %s`, t.algo, t.id_file));
        try {
          await execShellCommand(util.format(`ssh-keygen -q -t %s -N "" -f ${homedir}/.ssh/%s`, t.algo, t.id_file));
        } catch { }
        core.debug(util.format(`Generated SSH key for %s successfully`, t.algo));
      } else {
        core.debug(util.format(`SSH key for %s already exists`, t.algo));
      }
    }

    const uptermServer = core.getInput("upterm-server");
    const uptermServerHost = core.getInput("upterm-server").replace(/^[a-z]+:\/\/|:[0-9]+|/g, '');

    core.debug(`configuring ssh client for host ${uptermServerHost}`);
    const sshConfigPath = path.join(sshPath, "config");

    var sshConfig;
    try {
      sshConfig = SSHConfig.parse(
        fs
          .readFileSync(sshConfigPath, 'utf8')
          .replace(/\r\n/g, '\n')
      );
      sshConfig.remove({ Host: uptermServerHost });
    } catch {
      sshConfig = new SSHConfig();
    }

    const sshKnownHostsFile = path.join(sshPath, "known_hosts");

    sshConfig.prepend({
      Host: uptermServerHost,
      IdentityFile: `${home}/.ssh/id_ed25519`,
      UserKnownHostsFile: sshKnownHostsFile,
      StrictHostKeyChecking: `no`,
      CheckHostIP: `no`,
      TCPKeepAlive: `yes`,
      ServerAliveInterval: 30,
      ServerAliveCountMax: 180,
      VerifyHostKeyDNS: `yes`,
      UpdateHostKeys: `yes`,
      PasswordAuthentication: `no`,
      RequestTTY: `no`
    });
    const sshConfigString = SSHConfig.stringify(sshConfig).toString();
    core.debug(`new ssh config:\n${sshConfigString}`);
    fs.writeFileSync(sshConfigPath, sshConfigString);

    // entry in known hosts file in mandatory in upterm. attempt ssh connection to upterm server
    // to get the host key added to ~/.ssh/known_hosts
    if (core.getInput("ssh-known-hosts") && core.getInput("ssh-known-hosts") !== "") {
      core.info(`Appending ssh-known-hosts to ${sshKnownHostsFile}. Contents of ${sshKnownHostsFile}`)
      fs.appendFileSync(sshKnownHostsFile, core.getInput("ssh-known-hosts"))
    } else {
      core.debug(`Auto-generating ${sshKnownHostsFile} by attempting connection to ${uptermServer}`)
      if (fs.existsSync(sshKnownHostsFile)) {
        try {
          fs.renameSync(sshKnownHostsFile, `${sshKnownHostsFile}.bkp`);
        } catch (error) {
          core.warning(`error renaming ${sshKnownHostsFile}`);
        }
      }
      try {
        core.debug(await execShellCommand(`ssh -v -T -F ${sshConfigPath} ${uptermServer}`));
      } catch (error) {
        core.warning(`error connecting to ${uptermServer}: ${error}`);
      }

      // @cert-authority entry is the mandatory entry. generate the entry based on the known_hosts entry key
      try {
        const data = fs.readFileSync(sshKnownHostsFile, 'UTF-8')
        const lines = data.split(/\r?\n/)
        var appendix = [];
        lines.forEach(line => {
          var result = undefined;
          if (!line.includes("@")) {
            const split_line = line.split(/,| /);
            const one = split_line[1];
            const two = split_line[2];
            if (one != undefined && two != undefined) {
              result = util.format('@cert-authority * %s %s', one, two);
              appendix.push(result);
            }
          }
          core.debug(`processed line: ${line} => ${result}`);
        })
        fs.appendFileSync(sshKnownHostsFile, appendix.join('\n\n'))
      } catch (error) { core.error(`error processing ${sshKnownHostsFile}: ${error}`); }
    }

    let authorizedKeysParameter = ""

    let allowedUsers = core.getInput("limit-access-to-users").split(/[\s\n,]+/).filter(x => x !== "")
    if (core.getInput("limit-access-to-actor") === "true") {
      core.info(`Adding actor "${github.context.actor}" to allowed users.`)
      allowedUsers.push(github.context.actor)
    }
    const uniqueAllowedUsers = [...new Set(allowedUsers)]
    if (uniqueAllowedUsers.length > 0) {
      core.info(`Fetching SSH keys registered with GitHub profiles: ${uniqueAllowedUsers.join(', ')}`)
      const octokit = new Octokit({
        authStrategy: createActionAuth
      })
      let allowedKeys = []
      for (const allowedUser of uniqueAllowedUsers) {
        if (allowedUser) {
          try {
            let keys = await octokit.users.listPublicKeysForUser({
              username: allowedUser
            })
            for (const item of keys.data) {
              allowedKeys.push(item.key)
            }
          } catch (error) {
            core.error(`Error fetching keys for ${allowedUser}. Error: ${error.message}`)
          }
        }
      }
      if (allowedKeys.length === 0) {
        throw new Error(`No public SSH keys registered with GitHub profiles: ${uniqueAllowedUsers.join(', ')}`)
      }
      core.info(`Fetched ${allowedKeys.length} ssh public keys`)
      const authorizedKeysPath = path.join(sshPath, "authorized_keys")
      fs.appendFileSync(authorizedKeysPath, allowedKeys.join('\n'))
      authorizedKeysParameter = `-a "${authorizedKeysPath}"`
    }


    core.debug(`Creating a new session. Connecting to upterm server ${uptermServer}`)
    await execShellCommand(`tmux new -d -s upterm-wrapper`);
    await execShellCommand(`tmux new -d -s upterm`);
    {
      const innerCmd = "tmux attach -t upterm";
      await execShellCommand(`tmux send-keys -t upterm-wrapper.0 "upterm host --server '${uptermServer}' ${authorizedKeysParameter} --force-command '${innerCmd}' -- ${innerCmd}" ENTER`);
    }
    await sleep(2000)
    await execShellCommand("tmux send-keys -t upterm-wrapper.0 q C-m");
    // resize terminal for largest client by default
    await execShellCommand("tmux set -t upterm-wrapper window-size largest; tmux set -t upterm window-size largest")
    core.debug("Created new session successfully")

    core.debug("Fetching connection strings")
    core.debug("Entering main loop")
    while (true) {
      try {
        core.info(await execShellCommand(`upterm session current --admin-socket ${uptermSockGlob}`));
      } catch (error) {
        core.error(error.message);
        break
      }

      const skip = fs.existsSync("/continue") || fs.existsSync(path.join(process.env.GITHUB_WORKSPACE, "continue"))
      if (skip) {
        core.info("Exiting debugging session because '/continue' file was created")
        break
      }
      await sleep(30000)
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}
