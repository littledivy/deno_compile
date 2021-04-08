fmt:
	deno fmt --ignore=.deno

example:
	denoc tests/asset.js myBinary
	./myBinary

install:
	deno install -f -n denoc -A --unstable cli.ts