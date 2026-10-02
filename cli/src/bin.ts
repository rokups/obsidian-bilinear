import { main } from "./cli";

// The reader went away (`bilinear list | head`): that is not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
});

main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e);
    process.exitCode = 70;
  },
);
