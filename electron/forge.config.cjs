module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "GoalPort",
    extraResource: ["target/release/goalport-core.exe", "target/release/goalport-core-launcher.exe"]
  },
  makers: [
    { name: "@electron-forge/maker-squirrel", config: { name: "goalport_preview" } },
    { name: "@electron-forge/maker-zip", platforms: ["win32"] }
  ]
};
