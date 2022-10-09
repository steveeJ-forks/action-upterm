import os from "os"
import fs from "fs"
import path from "path"
import * as core from "@actions/core"
import * as github from "@actions/github"
import { Octokit } from "@octokit/rest"
const { createActionAuth } = require("@octokit/auth-action");

import { execShellCommand } from "./helpers"

const UPTERM_VERSION = "v0.7.6"

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function run() {
  try {
    if (process.platform === "win32") {
      core.info("Windows is not supported by upterm, skipping...")
      return
    }

    core.debug("Installing dependencies")
    if (process.platform == "linux") {
      try {
        await execShellCommand(`echo $PATH`)
        await execShellCommand(`upterm version`)
        core.debug("upterm is already installed.")
      } catch {
        core.debug("Installing upterm")
        await execShellCommand(`curl -sL https://github.com/owenthereal/upterm/releases/download/${UPTERM_VERSION}/upterm_linux_amd64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/`)
      }
      try {
        await execShellCommand(`tmux -V`)
        core.debug("tmux is already installed.")
      } catch {
        core.debug("Installing upterm")
        await execShellCommand("sudo apt-get -y install tmux")
      }
    } else {
      await execShellCommand("brew install owenthereal/upterm/upterm")
      await execShellCommand("brew install tmux")
    }
    core.debug("Installed dependencies successfully")

    const sshPath = path.join(os.homedir(), ".ssh")
    if (!fs.existsSync(sshPath)) {
      fs.mkdirSync(sshPath, { recursive: true });
    };

    for (const t of [
        {id_file:"id_rsa", algo:"rsa"},
        {id_file:"id_ed25519", algo:"ed25519"}
        ]) {
        if (!fs.existsSync(path.join(sshPath, t.id_file))) {
          core.debug("Generating ${t.algo} SSH key at ${t.id_file}", t.algo);
          try {
            await execShellCommand(`ssh-keygen -q -t ${t.algo} -N "" -f ~/.ssh/${t.id_file}`);
          } catch { }    
          core.debug("Generated SSH key for ${t.algo} successfully")
        } else {
          core.debug("SSH key for ${t.algo} already exists")
        }
    }

    core.debug("Configuring ssh client")
    fs.appendFileSync(path.join(sshPath, "config"), "Host *\nStrictHostKeyChecking no\nCheckHostIP no\n" +
      "TCPKeepAlive yes\nServerAliveInterval 30\nServerAliveCountMax 180\nVerifyHostKeyDNS yes\nUpdateHostKeys yes\n")
    // entry in known hosts file in mandatory in upterm. attempt ssh connection to upterm server
    // to get the host key added to ~/.ssh/known_hosts
    if (core.getInput("ssh-known-hosts") && core.getInput("ssh-known-hosts") !== "") {
      core.info("Appending ssh-known-hosts to ~/.ssh/known_hosts. Contents of ~/.ssh/known_hosts:")
      fs.appendFileSync(path.join(sshPath, "known_hosts"), core.getInput("ssh-known-hosts"))
      core.info(await execShellCommand('cat ~/.ssh/known_hosts'))
    } else {
      core.info("Auto-generating ~/.ssh/known_hosts by attempting connection to uptermd.upterm.dev")
      try {
        await execShellCommand("ssh -i ~/.ssh/id_ed25519 uptermd.upterm.dev")
      } catch { }
      // @cert-authority entry is the mandatory entry. generate the entry based on the known_hosts entry key
      try {
        await execShellCommand('cat <(cat ~/.ssh/known_hosts | awk \'{ print "@cert-authority * " $2 " " $3 }\') >> ~/.ssh/known_hosts')
      } catch { }
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
            core.info(`Error fetching keys for ${allowedUser}. Error: ${error.message}`)
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

    const uptermServer = core.getInput("upterm-server")
    core.info(`Creating a new session. Connecting to upterm server ${uptermServer}`)
    await execShellCommand(`tmux new -d -s upterm-wrapper -x 132 -y 43 \"upterm host --server '${uptermServer}' ${authorizedKeysParameter} --force-command 'tmux attach -t upterm' -- tmux new -s upterm -x 132 -y 43\"`)
    await sleep(2000)
    await execShellCommand("tmux send-keys -t upterm-wrapper q C-m")
    // resize terminal for largest client by default
    await execShellCommand("tmux set -t upterm-wrapper window-size largest; tmux set -t upterm window-size largest")
    console.debug("Created new session successfully")

    core.debug("Fetching connection strings")
    await sleep(1000)

    console.debug("Entering main loop")
    while (true) {
      try {
        core.info(await execShellCommand('bash -c "upterm session current --admin-socket ~/.upterm/*.sock"'));
      } catch (error) {
        core.info(error.message);
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
