/**
 * dsh-washer 的 Host 半。
 *
 * P0 的状态推导全部在浏览器端完成（投影 + chat 切片），Host 侧没有需要启动的东西。
 * 配置项由 cordis.patch.yml 的 config 块给出初值；用户在设置页的改动存在
 * localStorage（原因见 client.template.js 里「偏好持久化」一节）。
 */
export const name = 'dsh-washer';

export function apply() {}
