import { createApp } from './app.mjs';
const app = await createApp();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
await app.listen({ host, port });
console.log(`Habi本地服务：http://${host}:${port}`);
console.log(`食物分析：${app.provider.visionConfigured ? '已配置；手动分析或开启自动首图复核后上传' : '未配置，不生成热量数字'}；对话：${app.provider.chatConfigured ? '模型服务' : '本地基础规则'}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
