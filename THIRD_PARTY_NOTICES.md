# 第三方声明

本项目（`@sion10032/pi-sessions`）的部分实现改编自下列作品。

## pi-session-archive

| 项目 | 内容 |
| --- | --- |
| 名称 | `pi-session-archive`（npm：`@clementprevot/pi-session-archive`） |
| 作者 / 版权 | Copyright (c) 2026 Clément Prévot |
| 许可证 | MIT |
| 来源 | https://github.com/clementprevot/pi-session-archive |

改编自该作品的部分：

- 归档目录布局：`~/.pi/agent/sessions-archive/<cwd-slug>/` 下按 cwd 分组的会话文件，以及 `index.json` 元数据格式。
- 会话伴生文件的查找与移动：`<session>/` 目录、`.pi-agent-browser-artifacts/<id>`、`subagent-artifacts/` 下的运行产物。
- 归档目标文件已存在时的处理：能接上的“尾部续写”（tail continuation）合并，以及否则改名为 `.superseded-<timestamp>` 保留旧文件。
- 旧版 `[ARCHIVE] ` 名称标签的处理：展示时清理，恢复时从会话文件中剥除。

本项目在此基础上增加了整棵 `parentSession` 子树（子代理会话与 fork）的递归归档与恢复、`/sessions` 统一浏览界面，以及当前会话的延迟归档；这些为新增实现，不来自上游。

本项目为独立项目，与上述作品的作者没有隶属、赞助或背书关系。上游作者不对本项目的使用或缺陷承担任何责任。

以下为该作品的 MIT 许可证全文，作为署名与许可声明保留。

---

MIT License

Copyright (c) 2026 Clément Prévot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
