// 上游被裁掉的页面占位。原 chunk 已随阉割移除，这里保证引用不悬空、
// 万一被触达也只是渲染空白，而不是拿到 index.html 触发 MIME 报错。
export default { name: "TrimmedStub", render() { return null } }
