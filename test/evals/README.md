# 本地编码评测

两道小型任务用于在相同起点比较编码流程。`batch-end` 测试单文件修复，`quota-reservation` 测试跨文件实现。每道题都包含需要保留的用户改动和一套位于测试仓库外的验收条件。

## 准备和验收

从 Bruin 根目录运行，选择尚不存在的目标目录。两次准备同一道题会生成相同的 Git 基线提交、任务提示和未提交改动。

```sh
node test/evals/run.mjs prepare batch-end /tmp/bruin-batch-trial
node test/evals/run.mjs check batch-end /tmp/bruin-batch-trial
```

`prepare` 输出工作区路径、基线提交和完整提示词。`check` 从该提交计算变更，在独立 Node.js 进程校验实际行为，并检查用户注释、笔记和允许修改的路径。通过时退出码为 0。未修复的基线应该返回 1，同时显示用户改动完好。检查会加载受信任的评测工作区代码。

## 记录一次试跑

1. 为每个参评客户端创建新目录，使用同一个任务提示，并设置相同的模型、工具权限、时间预算和人工介入条件。隔离工作区记忆及已有会话。评测脚本自身只准备和检查文件。
2. 保留准备结果与检查结果。另记客户端版本、实际模型 ID、耗时、人工介入次数以及可取得的 token 用量，缺失字段标记未知。
3. 用 `git diff <基线提交>` 保留已跟踪变更，并用 `git ls-files --others --exclude-standard` 记录未跟踪路径。不要把验收脚本放进受测工作区。模型或权限条件不同时分别记录结果。

## 只读子 Agent 审查

`subagent-review.mjs` 在同一模型和预算下运行自由委派与结构化委派。两组各看一个有缺陷版本和一个无缺陷版本，目录名使用随机标识。评测走实际只读子 Agent 和文件执行器。评分同时核对路径、源代码行和可复现的反例，并记录真实读取、模型调用数、原始答复与工作区状态。

```sh
npm run build
node test/evals/subagent-review.mjs MODEL_ALIAS /tmp/bruin-review-trial
node test/evals/subagent-review.mjs MODEL_ALIAS /tmp/bruin-review-with-evidence --parent-evidence
```

目录须尚未存在，结果保存为其中的 `results.json`。第二条评测命令给两组相同的带行号源码快照，用于区分取证和审查推理。`--fixture-provider` 使用固定响应校验评测流程。对无缺陷样本，空报告应结合实际读文件记录判断。[本机模型原始结果](results/2026-11-23-subagent-review.json)
