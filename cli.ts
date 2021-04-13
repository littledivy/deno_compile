import { exists } from "https://deno.land/std@0.92.0/fs/exists.ts";
import { parse } from "https://deno.land/std@0.92.0/flags/mod.ts";
import { wait } from "https://deno.land/x/wait/mod.ts";

// Deno will be cloned from it's github repository to the below DIR.
// TODO(@littledivy): Can we make this global so builds don't
// start over everytime?
const DENO_DIR = ".deno/";
const DENO_CARGO_TOML = DENO_DIR + "cli/Cargo.toml";
const DENO_CLI_SOURCE = DENO_DIR + "cli/main.rs";
const DENO_ICU_SOURCE = DENO_DIR + "core/runtime.rs";
const BUNDLE_LOC = DENO_DIR + "cli/$bundle.js";
const RELEASE_BINARY = DENO_DIR + "target/release/deno";

export async function requires(...executables: string[]) {
  const where = Deno.build.os === "windows" ? "where" : "which";

  for (const executable of executables) {
    const process = Deno.run({
      cmd: [where, executable],
      stderr: "null",
      stdin: "null",
      stdout: "null",
    });

    if (!(await process.status()).success) {
      console.log(`could not find required build tool ${executable}`);
      Deno.exit(1);
    }
  }
}

async function cloneDeno() {
  await dispatch(
    ["git", "clone", "https://github.com/denoland/deno", DENO_DIR],
    "Cloning https://github.com/denoland/deno",
  );
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

interface CompileOptions {
  optLevel?: "0" | "1" | "2" | "3" | "s" | "z";
}

async function compileSource(options?: CompileOptions) {
  let buildCommand = ["cargo", "build", "--release"];
  if (options!.optLevel) {
    buildCommand.push(`-O=${options!.optLevel}`);
  }
  let p = Deno.run({
    cmd: buildCommand,
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

interface EmbedOptions {
  assets?: string[];
  icu: boolean;
}

async function dispatch(
  cmd: string[],
  text: string = "Loading...",
  deno_cwd: boolean = false,
) {
  let p = Deno.run({
    cmd,
    cwd: deno_cwd ? DENO_DIR : ".",
  });
  const spinner = wait(text).start();
  await p.status();
  spinner.succeed();
  spinner.stop();
}

async function bundle(source: string) {
  // Prefer `--no-check` - tsc slows things up
  await dispatch(
    ["deno", "bundle", "--no-check", source, BUNDLE_LOC],
    `Bundling ${source}`,
  );
  return await Deno.readTextFile(BUNDLE_LOC);
}

async function embed(source: string, options?: EmbedOptions) {
  let b = await bundle(source);
  const spinner = wait("Embedding source").start();
  if (options?.assets) {
    const assetsObj = JSON.stringify(
      Object.fromEntries(
        options.assets.map((asset) => [asset, Deno.readTextFileSync(asset)]),
      ),
    );
    b = `globalThis.Assets = ${assetsObj};\n` + b;
    await Deno.writeTextFile(BUNDLE_LOC, b);
  }
  const cliSource = await Deno.readTextFile(DENO_CLI_SOURCE);
  let skip: boolean = false;
  let newSource = cliSource
    .split("\n")
    .map((v: string) => {
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

    let code = include_str!("$bundle.js");
    unwrap_or_exit(tokio_util::run_basic(eval_command(Default::default(), code.to_string(), "js".to_string(), false)));
}`;
  await Deno.writeTextFile(DENO_CLI_SOURCE, newSource);

  if (!options!.icu) {
    // Removes the ICU data file (~10mb) embedded inside Deno.
    // WARNING: Calling `Intl` APIs without ICU data will result in segfaults.
    // https://github.com/denoland/deno/pull/10114#issuecomment-817160015
    let icuSource = await Deno.readTextFile(DENO_ICU_SOURCE);
    icuSource = icuSource.replace(
      `#[repr(C, align(16))]
      struct IcuData([u8; 10413584]);
      static ICU_DATA: IcuData = IcuData(*include_bytes!("icudtl.dat"));
      v8::icu::set_common_data(&ICU_DATA.0).unwrap();`,
      "",
    );
    await Deno.writeTextFile(DENO_ICU_SOURCE, icuSource);
  }

  spinner.succeed();
  spinner.stop();
}

// Should be called after `compileSource()`
async function moveBuild(name: string) {
  await Deno.rename(RELEASE_BINARY, name);
}

async function binaryOpt(loc: string) {
  await dispatch(["strip", loc], "Stripping debug symbols");
  await dispatch(["upx", loc], "Compressing binary with UPX");
}

await requires("git", "deno");

const args = parse(Deno.args);
const source = args._[0].toString();
const destFile = args._[1].toString() || "deno";
const { icon, name, copyright, desc, assets, opt, icu } = args;

class Backup {
  toml: string = Deno.readTextFileSync(DENO_CARGO_TOML);
  cliSource: string = Deno.readTextFileSync(DENO_CLI_SOURCE);
  async restore() {
    await Deno.writeTextFile(DENO_CARGO_TOML, this.toml);
    await Deno.writeTextFile(DENO_CLI_SOURCE, this.cliSource);
  }
}

let originalSource = new Backup();
window.addEventListener("unload", () => originalSource.restore());
await initaliseSource();
await embed(source, {
  assets: assets?.split(",").map((v: string) => v.trim()),
  icu: !!icu,
});
await compileSource({ optLevel: opt });
await moveBuild(destFile);
if (Deno.build.os === "linux") {
  await requires("strip", "upx");
  await binaryOpt(destFile);
}
