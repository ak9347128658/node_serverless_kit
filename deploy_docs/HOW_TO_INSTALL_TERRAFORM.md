# How to install Terraform (or OpenTofu)

nskit generates Terraform JSON and runs the `terraform` binary for `plan`, `deploy`, `remove`, `info --refresh` and `tf`. You need **Terraform >= 1.5** or **OpenTofu** on your `PATH`.

You don't need Terraform for `nskit init`, `validate`, `package`, `dev`, `invoke`, `workflow run` or the test suite.

nskit looks for a binary in this order: `provider.terraform.binary` in `nskit.yml`, the `NSKIT_TERRAFORM_BIN` environment variable, `terraform`, then `tofu`.

## Windows

**Option 1: winget**

```powershell
winget install --id Hashicorp.Terraform -e
```

Close and reopen the terminal so the new `PATH` loads, then:

```powershell
terraform -version
```

**Option 2: Chocolatey** (PowerShell as Administrator)

```powershell
choco install terraform -y
```

**Option 3: manual (no admin rights)**

1. Download the Windows AMD64 zip from <https://developer.hashicorp.com/terraform/install>.
2. Unzip it to e.g. `C:\tools\terraform\`, so you have `C:\tools\terraform\terraform.exe`.
3. Add the folder to your user `PATH` and reopen the terminal:

   ```powershell
   [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\tools\terraform", "User")
   ```

Or skip `PATH` and point nskit at the exe:

```powershell
$env:NSKIT_TERRAFORM_BIN = "C:\tools\terraform\terraform.exe"
```

## macOS

```bash
brew tap hashicorp/tap
brew install hashicorp/tap/terraform
terraform -version
```

Upgrade later with `brew upgrade hashicorp/tap/terraform`.

## Linux

**Debian / Ubuntu** (HashiCorp apt repository):

```bash
sudo apt-get update && sudo apt-get install -y gnupg software-properties-common wget
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt-get update && sudo apt-get install -y terraform
```

**RHEL / Fedora / Amazon Linux:**

```bash
sudo yum install -y yum-utils
sudo yum-config-manager --add-repo https://rpm.releases.hashicorp.com/RHEL/hashicorp.repo   # Fedora: .../fedora/hashicorp.repo, Amazon Linux: .../AmazonLinux/hashicorp.repo
sudo yum install -y terraform
```

**Manual (any distribution):**

```bash
TF_VERSION=1.9.8
curl -fsSLo terraform.zip "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_amd64.zip"   # arm64: linux_arm64
unzip terraform.zip terraform
sudo install terraform /usr/local/bin/terraform      # or: mkdir -p ~/.local/bin && mv terraform ~/.local/bin/
terraform -version
```

## OpenTofu

[OpenTofu](https://opentofu.org/) is an open-source fork of Terraform. nskit finds `tofu` automatically when `terraform` isn't on `PATH`.

```powershell
winget install --id OpenTofu.Tofu -e                 # Windows
```

```bash
brew install opentofu                                # macOS / Linuxbrew

# Linux (official installer script; see https://opentofu.org/docs/intro/install/)
curl --proto '=https' --tlsv1.2 -fsSL https://get.opentofu.org/install-opentofu.sh -o install-opentofu.sh
chmod +x install-opentofu.sh
./install-opentofu.sh --install-method deb           # or: rpm | standalone
rm install-opentofu.sh
tofu -version
```

To force OpenTofu even when Terraform is installed, set it per project:

```yaml
provider:
  terraform:
    binary: tofu
```

or per shell: `export NSKIT_TERRAFORM_BIN=tofu` (PowerShell: `$env:NSKIT_TERRAFORM_BIN = "tofu"`).

## Cache provider plugins (recommended)

Every `.nskit/<provider>-<stage>/` directory is its own Terraform workspace and downloads its own plugins. A shared cache saves time and disk space:

bash:

```bash
mkdir -p ~/.terraform.d/plugin-cache
export TF_PLUGIN_CACHE_DIR="$HOME/.terraform.d/plugin-cache"     # add to ~/.bashrc or ~/.zshrc
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.terraform.d\plugin-cache" | Out-Null
[Environment]::SetEnvironmentVariable("TF_PLUGIN_CACHE_DIR", "$env:USERPROFILE\.terraform.d\plugin-cache", "User")
```

## Verify with the repository check

From a clone of the repository:

```bash
npm ci
npm run validate:terraform                         # all 10 providers
npm run validate:terraform -- --provider aws       # one provider
```

The script builds the package if needed, renders a sample project per provider and runs `terraform init -backend=false` plus `terraform validate`. The first run downloads every provider plugin (a few hundred MB). No cloud credentials are needed: `validate` never calls cloud APIs. The output ends with `10/10 providers valid`.

Without Terraform the script explains how to install it and exits 0 (use `--strict` to make that an error).
