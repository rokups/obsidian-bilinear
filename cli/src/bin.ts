import { OpError } from "../../plugin/src/ops/io";
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
  stdin: async () => {
    if (process.stdin.isTTY) throw new OpError("the standard input is a terminal, so there is nothing to read; pipe the JSON into the command, or give a file path to --file");
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return text;
  },
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e);
    process.exitCode = 70;
  },
);
