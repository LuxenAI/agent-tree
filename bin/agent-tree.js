#!/usr/bin/env node

const path = require("path");
const { spawn } = require("child_process");

const electronBinary = require("electron");
const appRoot = path.join(__dirname, "..");

const child = spawn(electronBinary, [appRoot], {
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error("Failed to launch Agent Tree.");
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
