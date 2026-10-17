# 19 · On-premises deploy

The handler does not change between clouds. `provider.options.deploy` chooses how the built
files reach the server. `runtime` chooses what starts them when that server has no Node.js,
no npm and no Python.

This example is configured as `deploy: bundle` and `runtime: auto`, so packaging writes a
folder and does not connect anywhere.

```bash
npm install
npx nskit validate
npx nskit package
npx nskit dev
curl http://127.0.0.1:3000/health
```

`nskit package` writes `.nskit/onprem-dev/onprem/bundle/`. `START.txt` in that folder says how
to start it. On the server:

```bash
sh platform/start.sh
# Windows: powershell -NoProfile -ExecutionPolicy Bypass -File platform/start.ps1
curl http://127.0.0.1:8080/health
```

`runtime: auto` tries, in order, a Node binary shipped in `runtime/node`, Node.js 18+ on `PATH`,
then Docker. nskit does not download Node.js. Python is never invoked.

## Pick a target

| Server has | Config |
|---|---|
| Node.js 18+, and you deploy on that machine | `deploy: local` (example [18](../18-on-premises)) |
| Docker, and you deploy on that machine | `engine: docker` |
| Node.js 18+, over SSH | `deploy: ssh`, `runtime: system` |
| nothing installed | `deploy: ssh` or `bundle`, `runtime: bundled`, `node_binary` set |
| Docker, and no Node.js | `deploy: ssh` or `bundle`, `runtime: docker` |
| you carry the files (USB, air gap) | `deploy: bundle` (this example) |

### SSH to a server that already has Node.js

```yaml
provider:
  name: onprem
  options:
    deploy: ssh
    host: ops@10.0.0.8
    ssh_key: /home/ci/.ssh/id_ed25519
    remote_dir: /opt/nskit/on-prem-deploy
    runtime: system
    publish: 10.0.0.8
    http_port: 8080
```

The machine that runs `nskit` needs `ssh` and `tar`. The server needs `tar` and `sh`. There is
no password prompt. `nskit remove` stops the process and leaves the remote data directory.

### A server with no Node.js, npm, Docker or Python

Download a Node.js 18+ build for that operating system and CPU on a machine that has a network.
Point `node_binary` at `bin/node` or `node.exe`. nskit copies that one file into `runtime/node`.

```yaml
provider:
  name: onprem
  options:
    deploy: ssh
    host: ops@10.0.0.8
    runtime: bundled
    node_binary: ./third_party/node-v22-linux-x64/bin/node
```

On Windows set `target_os: windows`. The start script is `platform/start.ps1`.

### Docker is the only thing installed

```yaml
provider:
  name: onprem
  options:
    deploy: ssh
    host: ops@10.0.0.8
    runtime: docker
    node_image: node:22-bookworm-slim
```

`engine: docker` is a different switch. It starts containers on the machine running Terraform,
and it is rejected together with `deploy: ssh`.

### systemd on Linux

```yaml
provider:
  name: onprem
  options:
    deploy: ssh
    host: ops@10.0.0.8
    runtime: system
    service: systemd
    systemd_scope: user    # or system, which needs passwordless sudo
```

`user` over SSH needs `loginctl enable-linger` for that account. systemd is not used on Windows.

The full option list is in [docs/providers/onprem.md](../../docs/providers/onprem.md).
