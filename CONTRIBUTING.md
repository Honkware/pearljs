# Contributing

Bug reports, fixes and new features are welcome.

## Getting started

pearljs needs Node.js 20.19 or newer, or 22.12 or newer.

```sh
git clone https://github.com/Honkware/pearljs.git
cd pearljs
npm ci
npm run check
```

`npm run check` runs the linter, the typecheck, the build, the tests, the examples and the code in the docs. Run it before you send anything. The XMSS tests take several seconds each.

## Sending a change

Send a small fix as a pull request. For a larger change or anything that adds to the API, open an issue first, so the design is agreed before the work is done.

A pull request is easy to review when it:

- does one thing;
- comes with a test that fails without it, named as a sentence that says what it protects;
- passes `npm run check`;
- updates the guide or reference page for any behaviour a user can see.

Expected values in tests come from Pearl's own code, from a run against a real node, or from a published vector. They are never typed in by hand. [Development](docs/project/development.md#regenerating-vectors) lists the generators.

Commit subjects are plain sentences that say what changed, in the style of `git log`. Keep secrets, recovery phrases and real keys out of commits; the tests use the public BIP39 and BIP86 vectors.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, and not in an issue or a pull request.

## Questions

Open an issue. [Frequently asked questions](docs/start/faq.md) and [Troubleshooting](docs/reference/troubleshooting.md) cover what comes up most.

## Going further

[Development](docs/project/development.md) has the rest: what each script does, how to add a module, the tests against a real pearld and Oyster, regenerating vectors, rebuilding the proof verifier, and how the docs are checked.
