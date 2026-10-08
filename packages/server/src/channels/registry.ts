// Channel 抽象 + 注册表（app/channels/base.py + channels/wecom_channel.py 移植）。
// 注册表是模块级常量（Python 端 main.py import wecom_channel 时完成注册——TS 侧
// 直接静态注册 wecom）；活动实例是进程内 Map（channels.py 的 _active_channels 同构）。
// 配置持久化 ~/.vibe-seller/config/channels.json。

export interface ChannelMessage {
  channel_type: string;
  sender: string;
  content: string;
  subject: string;
  attachments: { name?: string; url?: string; type?: string }[];
  raw: Record<string, unknown>;
  message_id: string;
}

export interface BaseChannel {
  readonly channel_type: string;
  readonly read_write: boolean;
  configure(config: Record<string, unknown>): Promise<void>;
  poll(): Promise<ChannelMessage[]>;
  send?(content: string, recipient?: string): Promise<boolean>;
  close?(): Promise<void>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const CHANNEL_REGISTRY = new Map<string, (fetchImpl?: FetchLike) => BaseChannel>();
CHANNEL_REGISTRY.set("wecom", (fetchImpl) => new WeComChannel(fetchImpl));

export function getChannel(channelType: string, fetchImpl?: FetchLike): BaseChannel {
  const factory = CHANNEL_REGISTRY.get(channelType);
  if (!factory) {
    throw new Error(`Unknown channel type: ${channelType}. Available: ${[...CHANNEL_REGISTRY.keys()]}`);
  }
  return factory(fetchImpl);
}

export function channelTypes(): { type: string; read_write: boolean }[] {
  return [...CHANNEL_REGISTRY.entries()].map(([type, factory]) => ({ type, read_write: factory().read_write }));
}

const WECOM_TOKEN_URL = "https://qyapi.weixin.qq.com/cgi-bin/gettoken";
const WECOM_SEND_URL = "https://qyapi.weixin.qq.com/cgi-bin/message/send";

/** WeCom 自建应用渠道：收 @mention（webhook 回调积压）+ 主动发信。 */
export class WeComChannel implements BaseChannel {
  readonly channel_type = "wecom";
  readonly read_write = true;
  private config: Record<string, unknown> = {};
  private accessToken = "";
  private pending: ChannelMessage[] = [];

  constructor(private readonly fetchImpl: FetchLike = fetch as FetchLike) {}

  async configure(config: Record<string, unknown>): Promise<void> {
    this.config = config;
    if (config["corp_id"] && config["corp_secret"]) await this.refreshToken();
  }

  private async refreshToken(): Promise<void> {
    const corpId = String(this.config["corp_id"]);
    const corpSecret = String(this.config["corp_secret"]);
    try {
      const resp = await this.fetchImpl(`${WECOM_TOKEN_URL}?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`, { method: "GET" });
      const data = (await resp.json()) as { errcode?: number; access_token?: string };
      if (data.errcode === 0 && data.access_token) this.accessToken = data.access_token;
      else console.error(`[vibe-server] WeCom token error: errcode=${data.errcode}`);
    } catch (e) {
      console.error(`[vibe-server] WeCom token fetch failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** webhook 回调收到消息时入队（TS 侧无回调路由——与 Python 相同，积压即 poll 面）。 */
  pushMessage(msg: ChannelMessage): void {
    this.pending.push(msg);
  }

  async poll(): Promise<ChannelMessage[]> {
    const messages = [...this.pending];
    this.pending = [];
    return messages;
  }

  async send(content: string, recipient = ""): Promise<boolean> {
    const webhookUrl = this.config["webhook_url"];
    if (webhookUrl) return sendWebhookMessage(this.fetchImpl, String(webhookUrl), content);
    if (!this.accessToken) {
      await this.refreshToken();
      if (!this.accessToken) {
        console.error("[vibe-server] WeCom: no access token");
        return false;
      }
    }
    try {
      const payload: Record<string, unknown> = { agentid: Number(this.config["agent_id"] ?? 0), msgtype: "text", text: { content } };
      if (recipient.startsWith("@")) payload["chatid"] = recipient.replace(/^@+/, "");
      else payload["touser"] = recipient || "@all";
      const resp = await this.fetchImpl(`${WECOM_SEND_URL}?access_token=${encodeURIComponent(this.accessToken)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await resp.json()) as { errcode?: number };
      return data.errcode === 0;
    } catch (e) {
      console.error(`[vibe-server] WeCom send error: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }
}

async function sendWebhookMessage(fetchImpl: FetchLike, webhookUrl: string, content: string): Promise<boolean> {
  try {
    const resp = await fetchImpl(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msgtype: "text", text: { content } }) });
    const data = (await resp.json()) as { errcode?: number };
    return data.errcode === 0;
  } catch {
    return false;
  }
}
