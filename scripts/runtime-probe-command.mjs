const SYNTHETIC_TASK = "Reply exactly GOALPORT_RUNTIME_OK. Do not use tools, read or write files, access the network, or perform any external action.";

const LIVE_PROBES = {
  codex: {
    send: {
      argvClass: "codex.synthetic-exec",
      args: ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--cd", ".", SYNTHETIC_TASK]
    },
    probe: ["app-server", "--help"]
  },
  grok: {
    send: {
      argvClass: "grok.synthetic-headless",
      args: ["-p", SYNTHETIC_TASK, "--output-format", "streaming-json", "--max-turns", "1", "--no-subagents", "--disable-web-search"]
    },
    probe: ["agent", "--help"]
  },
  claude: {
    send: {
      argvClass: "claude.synthetic-print",
      args: ["-p", SYNTHETIC_TASK, "--output-format", "stream-json", "--max-turns", "1", "--verbose"]
    },
    probe: ["--help"]
  }
};

export function runtimeProbeCommand({ provider, executable, invocation, name, syntheticRoot, root }) {
  const live = LIVE_PROBES[provider];
  const spec = name === "send" ? live.send : {
    argvClass: executable + "." + name + "-capability-probe",
    args: live.probe
  };
  return {
    argvClass: spec.argvClass,
    command: invocation.command,
    args: [...invocation.prefix, ...spec.args],
    cwd: name === "send" ? syntheticRoot : root
  };
}
