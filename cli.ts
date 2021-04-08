import { exists } from "https://deno.land/std@0.92.0/fs/exists.ts";
import { parse } from "https://deno.land/std@0.92.0/flags/mod.ts";
import { wait } from "https://deno.land/x/wait/mod.ts";

// Deno will be cloned from it's github repository to the below DIR.
// TODO(@littledivy): Can we make this global so builds don't
// start over everytime?
const DENO_DIR = ".deno/";
const DENO_CARGO_TOML = DENO_DIR + "cli/Cargo.toml";
const DENO_CLI_SOURCE = DENO_DIR + "cli/main.rs";
const RELEASE_BINARY = DENO_DIR + "target/release/deno";

const args = parse(Deno.args);
const source = await Deno.readTextFile(args._[0].toString());
const destFile = args._[1].toString() || "deno";
const { icon } = args;

async function cloneDeno() {
  let p = Deno.run({
    cmd: ["git", "clone", "https://github.com/denoland/deno", DENO_DIR],
    stdout: "piped",
    stdin: "piped",
    stderr: "piped",
  });
  const spinner = wait("Cloning https://github.com/denoland/deno").start();
  await p.output();
  spinner.succeed();
  spinner.stop();
}

async function initaliseSource() {
  if (!await exists(DENO_DIR)) {
    await cloneDeno();
  }
}

interface WindowsMetaData {
  exeName: string;
  copyright: string;
  productName: string;
  description: string;
}

async function setMeta(meta: WindowsMetaData) {
  const tomlString = await Deno.readTextFile(DENO_CARGO_TOML);
  // Hacky but closely monitored across releases.
  // Feel free to make this better.
  const manipulated = tomlString.replaceAll("deno.exe", meta.exeName)
    .replace(
      "© Deno contributors & Deno Land Inc. MIT licensed.",
      meta.copyright,
    )
    .replace('ProductName = "Deno"', `ProductName = "${meta.productName}"`)
    .replace(
      'FileDescription = "Deno: A secure runtime for JavaScript and TypeScript"',
      `FileDescription = "${meta.description}"`,
    );

  await Deno.writeTextFile(DENO_CARGO_TOML, manipulated);
}

async function compileSource() {
  let p = Deno.run({
    cmd: ["cargo", "build", "--release"],
    stdout: "piped",
    stdin: "piped",
    stderr: "piped",
    cwd: DENO_DIR,
  });
  const spinner = wait(
    "Building Deno from source. This can take a few minutes.",
  ).start();
  await p.status();
  spinner.succeed();
  spinner.stop();
}

async function embed(bundle: string) {
  const spinner = wait("Embedding source").start();

  const cliSource = await Deno.readTextFile(DENO_CLI_SOURCE);
  let skip: boolean = false;
  let newSource = cliSource
    .split("\n")
    .map((v) => {
      if (v.includes("fn main()")) {
        skip = true;
      } else if (!skip) {
        return v;
      }
    })
    .join("\n")
    // Uh oh
    .replace("#![deny(warnings)]", "");
  newSource += `
pub fn main() { 
    #[cfg(windows)]
    colors::enable_ansi(); // For Windows 10

    let code = String::from(r#"${bundle}"#);
    unwrap_or_exit(tokio_util::run_basic(eval_command(Default::default(), code, "js".to_string(), false)));
}`;
  await Deno.writeTextFile(DENO_CLI_SOURCE, newSource);
  spinner.succeed();
  spinner.stop();
}

// Should be called after `compileSource()`
async function moveBuild(name: string) {
  await Deno.rename(RELEASE_BINARY, name);
}

await initaliseSource();
await embed(source);
await compileSource();
await moveBuild(destFile);
