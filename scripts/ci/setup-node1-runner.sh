#!/usr/bin/env bash
# Provision node1 as the GitHub Actions self-hosted runner for this repo.
# Runs ON node1, as the normal user (no sudo): everything lives in $HOME.
#
#   From the PC:  bash scripts/ci/install-node1-runner.sh
#   (fetches a short-lived registration token with `gh` and runs this over ssh)
#
# Installs: JDK 17 (~/ci/jdk17), Android cmdline-tools + licenses (~/ci/android-sdk;
# Gradle pulls the platforms/build-tools/NDK it needs on first build),
# actions runner (~/actions-runner) as a systemd --user service with linger.
#
# node1 is build/test infrastructure only — it never runs the Hub or any sync
# (product lock: Hub + sync stay on the operator PC).
set -euo pipefail

REPO_URL="${REPO_URL:?REPO_URL required (https://github.com/owner/repo)}"
RUNNER_TOKEN="${RUNNER_TOKEN:?RUNNER_TOKEN required}"
RUNNER_VERSION="${RUNNER_VERSION:-2.337.0}"
RUNNER_NAME="${RUNNER_NAME:-node1}"
RUNNER_LABELS="${RUNNER_LABELS:-node1,android}"
CI="$HOME/ci"
SDK="$CI/android-sdk"
JDK="$CI/jdk17"
RUNNER_DIR="$HOME/actions-runner"

mkdir -p "$CI"

unzip_py() { python3 - "$1" "$2" <<'PY'
import sys, zipfile, os
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        path = z.extract(info, dst)
        mode = (info.external_attr >> 16) & 0o777
        if mode:
            os.chmod(path, mode)
PY
}

# --- JDK 17 ---------------------------------------------------------------
if [ ! -x "$JDK/bin/java" ]; then
  echo "== JDK 17"
  tmp="$(mktemp -d)"
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse" -o "$tmp/jdk.tgz"
  mkdir -p "$JDK"
  tar -xzf "$tmp/jdk.tgz" -C "$JDK" --strip-components=1
  rm -rf "$tmp"
fi
"$JDK/bin/java" -version 2>&1 | head -1

# --- Android SDK (cmdline-tools + licenses) -------------------------------
export JAVA_HOME="$JDK"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "== Android cmdline-tools"
  tmp="$(mktemp -d)"
  curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip" -o "$tmp/clt.zip"
  unzip_py "$tmp/clt.zip" "$tmp"
  mkdir -p "$SDK/cmdline-tools"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$tmp"
fi
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
"$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platform-tools" >/dev/null
echo "android sdk: $SDK"

# --- GitHub CLI (release job uploads with gh) -----------------------------
if [ ! -x "$HOME/.local/bin/gh" ]; then
  echo "== gh"
  ver="$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | python3 -c 'import sys,json;print(json.load(sys.stdin)["tag_name"].lstrip("v"))')"
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/cli/cli/releases/download/v${ver}/gh_${ver}_linux_amd64.tar.gz" | tar -xz -C "$tmp"
  mkdir -p "$HOME/.local/bin"
  mv "$tmp/gh_${ver}_linux_amd64/bin/gh" "$HOME/.local/bin/gh"
  rm -rf "$tmp"
fi

# --- Actions runner -------------------------------------------------------
if [ ! -x "$RUNNER_DIR/run.sh" ]; then
  echo "== actions runner $RUNNER_VERSION"
  mkdir -p "$RUNNER_DIR"
  curl -fsSL "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    | tar -xz -C "$RUNNER_DIR"
fi

cd "$RUNNER_DIR"
./config.sh --unattended --replace \
  --url "$REPO_URL" --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work _work

# Environment every job sees (the runner reads .env at start).
cat > "$RUNNER_DIR/.env" <<EOF
JAVA_HOME=$JDK
ANDROID_HOME=$SDK
ANDROID_SDK_ROOT=$SDK
PATH=$JDK/bin:$SDK/platform-tools:$SDK/cmdline-tools/latest/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
LANG=C.UTF-8
EOF

# --- systemd --user service ----------------------------------------------
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/github-runner.service" <<EOF
[Unit]
Description=GitHub Actions runner ($RUNNER_NAME) for $REPO_URL
After=network-online.target

[Service]
WorkingDirectory=$RUNNER_DIR
ExecStart=$RUNNER_DIR/run.sh
Restart=always
RestartSec=10
KillMode=process
KillSignal=SIGINT
TimeoutStopSec=5min

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now github-runner.service

# Keep the user service running without a login session (and after reboot).
if ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "WARN: could not enable linger without sudo — run once on node1: sudo loginctl enable-linger $USER"
fi
loginctl show-user "$USER" -p Linger
systemctl --user --no-pager status github-runner.service | head -5
