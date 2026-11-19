#!/usr/bin/env python3
"""Writes the licence texts of every crate verifier.wasm links, for wasm/build.sh.

The crates are cargo's normal dependency graph for wasm32-unknown-unknown,
without proc macros, which run at build time and leave no code behind. Each
crate's licence files are copied as the crate ships them, each distinct text once with the crates that ship it; a crate without one
gets its Cargo.toml licence expression, and Pearl's own crates the licence at
the root of Pearl's repository.
"""
import json
import os
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
pearl = os.path.realpath(sys.argv[1])
out = sys.argv[2]

meta = json.loads(subprocess.check_output(
    ['cargo', 'metadata', '--format-version', '1', '--locked', '--filter-platform', 'wasm32-unknown-unknown'], cwd=here))
packages = {p['id']: p for p in meta['packages']}
nodes = {n['id']: n for n in meta['resolve']['nodes']}

linked, todo = set(), [meta['resolve']['root']]
while todo:
    pid = todo.pop()
    if pid in linked:
        continue
    linked.add(pid)
    for dep in nodes[pid]['deps']:
        if any(k['kind'] is None for k in dep['dep_kinds']) and not any('proc-macro' in t['kind'] for t in packages[dep['pkg']]['targets']):
            todo.append(dep['pkg'])

groups = {}
for pid in sorted(linked, key=lambda i: (packages[i]['name'], packages[i]['version'])):
    p = packages[pid]
    if p['name'] == 'pearljs-verify-proof':
        continue
    root = os.path.dirname(p['manifest_path'])
    files = sorted(f for f in os.listdir(root) if f.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'UNLICENSE')))
    # Where MIT is one of the choices, verifier.wasm takes the crate under MIT.
    lic = (p['license'] or '').replace('/', ' OR ')
    if ' OR ' in lic and 'MIT' in lic.split(' OR ') and any('MIT' in f.upper() for f in files):
        files = [f for f in files if 'MIT' in f.upper()]
    if not files and (root.startswith(os.path.join(here, 'vendor')) or root.startswith(pearl)):
        root, files = pearl, ['LICENSE']
    header = f"{p['name']} {p['version']}" + (f" ({p['license']})" if p['license'] else '')
    texts = [open(os.path.join(root, f), encoding='utf-8', errors='replace').read().strip() for f in files]
    for text in texts or [f"License: {p['license']}"]:
        # Copies of one licence differ in wrapping and indentation only; keep the first.
        key = ' '.join(text.split())
        groups.setdefault(key, (text, []))[1].append(header)

with open(out, 'w', encoding='utf-8') as f:
    f.write('Licences of the Rust crates compiled into verifier.wasm, as each crate ships them.\n\n')
    f.write(('\n\n' + '=' * 78 + '\n\n').join('\n'.join(crates) + '\n\n' + text for text, crates in groups.values()) + '\n')
print(f'{len(linked) - 1} crates, {len(groups)} distinct texts')
