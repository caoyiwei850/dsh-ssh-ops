# 依赖许可证核查（2026-11-06）

本记录覆盖本项目当前 `package-lock.json` 中的 189 个包路径（按安装路径计数，包含重复版本和平台可选包），并按实际 bundle 输入区分打包内容与外部依赖。它是当前版本的工程核查记录，不替代对未来版本或第三方完整权利链的法律判断。

## 结论与适用范围

- 包并非全部 MIT。当前锁定版本的许可包括 MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、Unlicense 和 BlueOak-1.0.0；核查的包级元数据和许可文件中未发现 GPL、AGPL、LGPL、SSPL 或 RSAL 条款。
- 上述许可未显示要求将本项目原创代码整体改为其他许可证的条件；MIT 根许可证保留。第三方材料仍适用各自条款，分发时保留许可证、版权、署名及相关 NOTICE。
- `mongodb@6.21.0` 是 Apache-2.0 的 Node.js 驱动，`redis@4.7.1` 是 MIT 的 Node.js 客户端，不能把数据库服务器产品的许可直接套用于这两个包，也不能据此推断其他版本的许可。
- 本 PR 未新增或升级任何依赖。许可补全覆盖既有 bundle 中的第三方内容。终端默认配色与语义规则为本项目独立设计，不属于第三方内容。
- 版本范围和 peerDependencies 可在后续安装中解析为其他版本。以下结论只覆盖本锁文件与已核验的 tarball；更新依赖后需重新核查，不能沿用此表作为新版本的保证。

## 核查方式

1. 读取锁文件与实际安装包的 `package.json`，对比版本与许可声明；读取直接依赖和非 MIT 包的 LICENSE/COPYING 等文件。
2. 两个本机未安装且锁文件未标许可的可选包 `buildcheck@0.0.7`、`cpu-features@0.0.10`，直接读取 npm 官方 tarball，并核对锁文件 SHA-512；均使用旧式 `licenses` 字段声明 MIT。cpu-features 内置 Google cpu_features，另含 Apache-2.0 许可证，应随组装后的原生安装保留。
3. 使用与 host/client/worker 构建一致的入口、external 和 target 选项生成 esbuild metafile（不写入产物），定位实际纳入 bundle 的 14 个不同 npm 包。包的 devDependencies 标记不代表它不会出现在发布产物中。
4. 保存这些包的完整许可文件及包内 BSON vendor 许可文本到 `licenses/bundled-dependencies.txt`；包内 vendor 声明包括 Apache-2.0/Unlicense 双许可及 MIT。外部运行依赖由 npm 安装时保留各自许可文件。
5. 终端默认配色与语义高亮规则为本项目独立设计（见[第三方声明](../THIRD_PARTY_NOTICES.md)），不属于第三方内容；其对比度与语义行为由 `test/terminal-appearance-*.mjs` 覆盖。

补充：`esrecurse@4.3.0` 的 BSD 条款位于 `esrecurse.js` 文件头，而非独立 LICENSE；`@humanfs/types@0.15.0` 在 package.json 和 README 中明确声明 Apache-2.0，但其 npm 包未附许可全文。两者均仅用于构建工具链且未进入 bundle；后者在重新分发完整构建环境时应补带 Apache-2.0 文本。

核查锁文件 SHA-256（LF 换行）：`81c43cef635b63f649d6a90135c0a5f3e7ddee50a2a4fc59ed1aba5e6198b811`。

## 许可分布

以下按包级元数据统计，统一了旧式 `licenses` 字段；vendor 子文件和 bcrypt-pbkdf 内 BSD/ISC 组合说明不另增加包数量。

| 许可 | 包路径数 |
| --- | ---: |
| Apache-2.0 | 17 |
| BSD-2-Clause | 7 |
| BSD-3-Clause | 2 |
| BlueOak-1.0.0 | 1 |
| ISC | 7 |
| MIT | 154 |
| Unlicense | 1 |

## 直接依赖

| 包 | 锁定版本 | 角色 | 许可 |
| --- | --- | --- | --- |
| `@types/node` | 26.2.0 | 直接依赖 | MIT |
| `mysql2` | 3.23.3 | 直接依赖 | MIT |
| `pg` | 8.23.0 | 直接依赖 | MIT |
| `pg-cursor` | 2.22.0 | 直接依赖 | MIT |
| `redis` | 4.7.1 | 直接依赖 | MIT |
| `ssh2` | 1.17.0 | 直接依赖 | MIT |
| `zod` | 4.4.3 | 直接依赖 | MIT |
| `@deepseek-ai/cordis` | 4.0.2 | 开发依赖 | MIT |
| `@deepseek-ai/dsh-credentials` | 0.1.2-rc.1 | 开发依赖 | MIT |
| `@deepseek-ai/dsh-storage-domain` | 0.1.2-rc.1 | 开发依赖 | MIT |
| `@deepseek-ai/dsh-tools` | 0.1.2-rc.1 | 开发依赖 | MIT |
| `@deepseek-ai/dsh-typert-protocol` | 0.1.2-rc.1 | 开发依赖 | MIT |
| `@eslint/js` | 10.0.1 | 开发依赖 | MIT |
| `@xterm/addon-fit` | 0.10.0 | 开发依赖 | MIT |
| `@xterm/addon-search` | 0.15.0 | 开发依赖 | MIT |
| `@xterm/xterm` | 5.5.0 | 开发依赖 | MIT |
| `mongodb` | 6.21.0 | 开发依赖 | Apache-2.0 |
| `esbuild` | 0.24.2 | 开发依赖 | MIT |
| `eslint` | 10.10.0 | 开发依赖 | MIT |
| `globals` | 17.12.0 | 开发依赖 | MIT |
| `react` | 18.3.1 | 开发依赖 | MIT |

四个 DSH peer 包与表中对应的本地开发包均声明 MIT；宿主实际提供的其他版本需按实际包重新确认。React 为宿主外部依赖。虽然 @types/node 列在 dependencies，其内容为类型声明，不等于独立 Node.js 运行时被打包。

## 实际打包与分发

具体包名、版本与完整许可见[第三方声明](../THIRD_PARTY_NOTICES.md)及[随包许可文本](../licenses/bundled-dependencies.txt)。

- host：11 个包，包括 MongoDB、BSON、连接串解析器及其依赖、Zod。webidl-conversions 使用 BSD-2-Clause，其版权与免责声明也需保留。
- client：xterm、fit/search addon、Zod 共 4 个包；Zod 与 host 重复，因此合计为 14 个不同包。xterm CSS 同样受其 MIT 许可覆盖。
- worker：无 npm 包代码，仅包含本项目源码。
- ssh2、mysql2、pg、pg-cursor、redis 及其运行依赖保持 external，由包管理器安装。若另行分发包含 node_modules 的完整安装，需要一起保留它们原包内的 LICENSE、COPYING、NOTICE 及原生 vendor 许可。
- ESLint 工具链包含 Apache-2.0、BSD、ISC，以及 minimatch@10.2.6 的 BlueOak-1.0.0。它们不在运行 bundle 中；若重新分发构建环境，也应保留原包许可。

## 全部锁定包清单

| 锁文件路径 | 版本 | 包级许可 | 锁文件角色 |
| --- | --- | --- | --- |
| `node_modules/@cacheable/memory` | 2.2.0 | MIT | 开发 |
| `node_modules/@cacheable/utils` | 2.5.0 | MIT | 开发 |
| `node_modules/@deepseek-ai/cordis` | 4.0.2 | MIT | 开发 |
| `node_modules/@deepseek-ai/cosmokit` | 1.8.3 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-agent` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-brand` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-code-runtime` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-credentials` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-invariants` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-llm` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-scope` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-session` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-session-projection` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-storage` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-storage-domain` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-system-prompt` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-timeout` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-tools` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-typert-protocol` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-user-approval` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-util-crypto` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/dsh-util-values` | 0.1.2-rc.1 | MIT | 开发 |
| `node_modules/@deepseek-ai/schemastery` | 3.18.2 | MIT | 开发 |
| `node_modules/@esbuild/aix-ppc64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/android-arm` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/android-arm64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/android-x64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/darwin-arm64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/darwin-x64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/freebsd-arm64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/freebsd-x64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/linux-arm` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/linux-arm64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/linux-ia32` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/linux-loong64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/linux-mips64el` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/linux-ppc64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/linux-riscv64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/linux-s390x` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/linux-x64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/netbsd-arm64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/netbsd-x64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/openbsd-arm64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/openbsd-x64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/sunos-x64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/win32-arm64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/win32-ia32` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@esbuild/win32-x64` | 0.24.2 | MIT | 开发 / 可选 |
| `node_modules/@eslint-community/eslint-utils` | 4.10.1 | MIT | 开发 |
| `node_modules/@eslint-community/eslint-utils/node_modules/eslint-visitor-keys` | 3.4.3 | Apache-2.0 | 开发 |
| `node_modules/@eslint-community/regexpp` | 4.12.2 | MIT | 开发 |
| `node_modules/@eslint/config-array` | 0.23.5 | Apache-2.0 | 开发 |
| `node_modules/@eslint/config-helpers` | 0.7.0 | Apache-2.0 | 开发 |
| `node_modules/@eslint/core` | 1.2.1 | Apache-2.0 | 开发 |
| `node_modules/@eslint/js` | 10.0.1 | MIT | 开发 |
| `node_modules/@eslint/object-schema` | 3.0.5 | Apache-2.0 | 开发 |
| `node_modules/@eslint/plugin-kit` | 0.7.3 | Apache-2.0 | 开发 |
| `node_modules/@humanfs/core` | 0.19.2 | Apache-2.0 | 开发 |
| `node_modules/@humanfs/node` | 0.16.8 | Apache-2.0 | 开发 |
| `node_modules/@humanfs/types` | 0.15.0 | Apache-2.0 | 开发 |
| `node_modules/@humanwhocodes/module-importer` | 1.0.1 | Apache-2.0 | 开发 |
| `node_modules/@humanwhocodes/retry` | 0.4.3 | Apache-2.0 | 开发 |
| `node_modules/@keyv/bigmap` | 1.3.1 | MIT | 开发 |
| `node_modules/@keyv/serialize` | 1.1.1 | MIT | 开发 |
| `node_modules/@mongodb-js/saslprep` | 1.4.13 | MIT | 开发 |
| `node_modules/@redis/bloom` | 1.2.0 | MIT | 运行 |
| `node_modules/@redis/client` | 1.6.1 | MIT | 运行 |
| `node_modules/@redis/graph` | 1.1.1 | MIT | 运行 |
| `node_modules/@redis/json` | 1.0.7 | MIT | 运行 |
| `node_modules/@redis/search` | 1.2.0 | MIT | 运行 |
| `node_modules/@redis/time-series` | 1.1.0 | MIT | 运行 |
| `node_modules/@standard-schema/spec` | 1.1.0 | MIT | 开发 |
| `node_modules/@types/esrecurse` | 4.3.1 | MIT | 开发 |
| `node_modules/@types/estree` | 1.0.9 | MIT | 开发 |
| `node_modules/@types/json-schema` | 7.0.15 | MIT | 开发 |
| `node_modules/@types/node` | 26.2.0 | MIT | 运行 |
| `node_modules/@types/webidl-conversions` | 7.0.3 | MIT | 开发 |
| `node_modules/@types/whatwg-url` | 11.0.5 | MIT | 开发 |
| `node_modules/@xterm/addon-fit` | 0.10.0 | MIT | 开发 |
| `node_modules/@xterm/addon-search` | 0.15.0 | MIT | 开发 |
| `node_modules/@xterm/xterm` | 5.5.0 | MIT | 开发 |
| `node_modules/acorn` | 8.18.0 | MIT | 开发 |
| `node_modules/acorn-jsx` | 5.3.2 | MIT | 开发 |
| `node_modules/ajv` | 6.15.0 | MIT | 开发 |
| `node_modules/asn1` | 0.2.6 | MIT | 运行 |
| `node_modules/aws-ssl-profiles` | 1.1.2 | MIT | 运行 |
| `node_modules/balanced-match` | 4.0.4 | MIT | 开发 |
| `node_modules/bcrypt-pbkdf` | 1.0.2 | BSD-3-Clause | 运行 |
| `node_modules/brace-expansion` | 5.0.9 | MIT | 开发 |
| `node_modules/bson` | 6.10.4 | Apache-2.0 | 开发 |
| `node_modules/buildcheck` | 0.0.7 | MIT | 运行 / 可选 |
| `node_modules/cacheable` | 2.5.0 | MIT | 开发 |
| `node_modules/cluster-key-slot` | 1.1.2 | Apache-2.0 | 运行 |
| `node_modules/cpu-features` | 0.0.10 | MIT | 运行 / 可选 |
| `node_modules/cross-spawn` | 7.0.6 | MIT | 开发 |
| `node_modules/debug` | 4.4.3 | MIT | 开发 |
| `node_modules/deep-is` | 0.1.4 | MIT | 开发 |
| `node_modules/esbuild` | 0.24.2 | MIT | 开发 |
| `node_modules/escape-string-regexp` | 4.0.0 | MIT | 开发 |
| `node_modules/eslint` | 10.10.0 | MIT | 开发 |
| `node_modules/eslint-scope` | 9.1.2 | BSD-2-Clause | 开发 |
| `node_modules/eslint-visitor-keys` | 5.0.1 | Apache-2.0 | 开发 |
| `node_modules/espree` | 11.2.0 | BSD-2-Clause | 开发 |
| `node_modules/esquery` | 1.7.0 | BSD-3-Clause | 开发 |
| `node_modules/esrecurse` | 4.3.0 | BSD-2-Clause | 开发 |
| `node_modules/estraverse` | 5.3.0 | BSD-2-Clause | 开发 |
| `node_modules/esutils` | 2.0.3 | BSD-2-Clause | 开发 |
| `node_modules/fast-deep-equal` | 3.1.3 | MIT | 开发 |
| `node_modules/fast-json-stable-stringify` | 2.1.0 | MIT | 开发 |
| `node_modules/fast-levenshtein` | 2.0.6 | MIT | 开发 |
| `node_modules/file-entry-cache` | 11.1.5 | MIT | 开发 |
| `node_modules/find-up` | 5.0.0 | MIT | 开发 |
| `node_modules/flat-cache` | 6.1.23 | MIT | 开发 |
| `node_modules/flatted` | 3.4.4 | ISC | 开发 |
| `node_modules/generate-function` | 2.3.1 | MIT | 运行 |
| `node_modules/generic-pool` | 3.9.0 | MIT | 运行 |
| `node_modules/glob-parent` | 6.0.2 | ISC | 开发 |
| `node_modules/globals` | 17.12.0 | MIT | 开发 |
| `node_modules/hashery` | 1.5.1 | MIT | 开发 |
| `node_modules/hookified` | 1.15.1 | MIT | 开发 |
| `node_modules/iconv-lite` | 0.7.3 | MIT | 运行 |
| `node_modules/ignore` | 5.3.2 | MIT | 开发 |
| `node_modules/imurmurhash` | 0.1.4 | MIT | 开发 |
| `node_modules/is-extglob` | 2.1.1 | MIT | 开发 |
| `node_modules/is-glob` | 4.0.3 | MIT | 开发 |
| `node_modules/is-property` | 1.0.2 | MIT | 运行 |
| `node_modules/isexe` | 2.0.0 | ISC | 开发 |
| `node_modules/js-tokens` | 4.0.0 | MIT | 开发 |
| `node_modules/json-schema-traverse` | 0.4.1 | MIT | 开发 |
| `node_modules/json-stable-stringify-without-jsonify` | 1.0.1 | MIT | 开发 |
| `node_modules/keyv` | 5.6.0 | MIT | 开发 |
| `node_modules/levn` | 0.4.1 | MIT | 开发 |
| `node_modules/locate-path` | 6.0.0 | MIT | 开发 |
| `node_modules/long` | 5.3.2 | Apache-2.0 | 运行 |
| `node_modules/loose-envify` | 1.4.0 | MIT | 开发 |
| `node_modules/lru.min` | 1.1.4 | MIT | 运行 |
| `node_modules/memory-pager` | 1.5.0 | MIT | 开发 |
| `node_modules/minimatch` | 10.2.6 | BlueOak-1.0.0 | 开发 |
| `node_modules/mongodb` | 6.21.0 | Apache-2.0 | 开发 |
| `node_modules/mongodb-connection-string-url` | 3.0.2 | Apache-2.0 | 开发 |
| `node_modules/ms` | 2.1.3 | MIT | 开发 |
| `node_modules/mysql2` | 3.23.3 | MIT | 运行 |
| `node_modules/named-placeholders` | 1.1.6 | MIT | 运行 |
| `node_modules/nan` | 2.28.0 | MIT | 运行 / 可选 |
| `node_modules/natural-compare` | 1.4.0 | MIT | 开发 |
| `node_modules/optionator` | 0.9.4 | MIT | 开发 |
| `node_modules/p-limit` | 3.1.0 | MIT | 开发 |
| `node_modules/p-locate` | 5.0.0 | MIT | 开发 |
| `node_modules/path-exists` | 4.0.0 | MIT | 开发 |
| `node_modules/path-key` | 3.1.1 | MIT | 开发 |
| `node_modules/pg` | 8.23.0 | MIT | 运行 |
| `node_modules/pg-cloudflare` | 1.4.0 | MIT | 运行 / 可选 |
| `node_modules/pg-connection-string` | 2.14.0 | MIT | 运行 |
| `node_modules/pg-cursor` | 2.22.0 | MIT | 运行 |
| `node_modules/pg-int8` | 1.0.1 | ISC | 运行 |
| `node_modules/pg-pool` | 3.14.0 | MIT | 运行 |
| `node_modules/pg-protocol` | 1.16.0 | MIT | 运行 |
| `node_modules/pg-types` | 2.2.0 | MIT | 运行 |
| `node_modules/pgpass` | 1.0.5 | MIT | 运行 |
| `node_modules/postgres-array` | 2.0.0 | MIT | 运行 |
| `node_modules/postgres-bytea` | 1.0.1 | MIT | 运行 |
| `node_modules/postgres-date` | 1.0.7 | MIT | 运行 |
| `node_modules/postgres-interval` | 1.2.0 | MIT | 运行 |
| `node_modules/prelude-ls` | 1.2.1 | MIT | 开发 |
| `node_modules/punycode` | 2.3.1 | MIT | 开发 |
| `node_modules/qified` | 0.10.1 | MIT | 开发 |
| `node_modules/qified/node_modules/hookified` | 2.2.0 | MIT | 开发 |
| `node_modules/react` | 18.3.1 | MIT | 开发 |
| `node_modules/redis` | 4.7.1 | MIT | 运行 |
| `node_modules/safer-buffer` | 2.1.2 | MIT | 运行 |
| `node_modules/shebang-command` | 2.0.0 | MIT | 开发 |
| `node_modules/shebang-regex` | 3.0.0 | MIT | 开发 |
| `node_modules/sparse-bitfield` | 3.0.3 | MIT | 开发 |
| `node_modules/split2` | 4.2.0 | ISC | 运行 |
| `node_modules/sql-escaper` | 1.5.1 | MIT | 运行 |
| `node_modules/ssh2` | 1.17.0 | MIT | 运行 |
| `node_modules/tr46` | 5.1.1 | MIT | 开发 |
| `node_modules/tweetnacl` | 0.14.5 | Unlicense | 运行 |
| `node_modules/type-check` | 0.4.0 | MIT | 开发 |
| `node_modules/undici-types` | 8.3.0 | MIT | 运行 |
| `node_modules/uri-js` | 4.4.1 | BSD-2-Clause | 开发 |
| `node_modules/webidl-conversions` | 7.0.0 | BSD-2-Clause | 开发 |
| `node_modules/whatwg-url` | 14.2.0 | MIT | 开发 |
| `node_modules/which` | 2.0.2 | ISC | 开发 |
| `node_modules/word-wrap` | 1.2.5 | MIT | 开发 |
| `node_modules/xtend` | 4.0.2 | MIT | 运行 |
| `node_modules/yallist` | 4.0.0 | ISC | 运行 |
| `node_modules/yocto-queue` | 0.1.0 | MIT | 开发 |
| `node_modules/zod` | 4.4.3 | MIT | 运行 |

## 后续维护

依赖版本或构建 external 列表变化时，重新生成实际 bundle 输入清单，核查对应包及 vendor 子文件，刷新完整许可文本和本记录；运行构建、打包清单测试，并检查最终 tgz/zip 确实包含第三方声明和许可文件。只保留一个 SPDX 名称或网页链接不能替代需要随包分发的许可全文。

本次核查基于原作者发布的声明和文件，不证明第三方没有未披露的权利瑕疵。
