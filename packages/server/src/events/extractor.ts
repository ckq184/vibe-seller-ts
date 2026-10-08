// LLM 事件抽取（app/events_system/extractor.py 移植）。
// 注意：PRD 称其为"纯规则"，实读参考实现是 Anthropic Messages API 调用
// （claude-haiku-4-5，EXTRACTION_PROMPT，JSON 数组输出）——按参考实现移植，
// fetch 直连（零依赖红线），transport 可注入。无 ANTHROPIC_API_KEY →
// 与原实现一致：RuntimeError 被 catch → 返回 []（所以无 key 时 channel poll
// 的 events_created 恒 0，与参考行为等价）。

const EXTRACTION_PROMPT = `You are an event extraction assistant for an e-commerce operations team.

Given a message from an email or chat channel, extract any actionable events such as:
- Deadlines (registration deadlines, submission deadlines)
- Promotions / sales events (flash sales, campaigns)
- Meetings or calls
- Platform announcements with dates

For each event, extract:
- title: short event title
- event_date: ISO 8601 date or datetime (if mentioned)
- deadline: ISO 8601 deadline date (if different from event_date)
- platform: e-commerce platform name (amazon, noon, etc.) if mentioned
- store_name: store name if mentioned
- description: brief description

Return a JSON array of events. If no events found, return [].
Example: [{"title": "Middle East campaign registration deadline", "deadline": "2026-03-15", "platform": "amazon", "store_name": "store1", "description": "Registration deadline for Middle East promotional campaign"}]

Respond ONLY with the JSON array, no other text.`.trim();

const MODEL = "claude-haiku-4-5-20251001";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class EventExtractor {
  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  async extractEvents(messageText: string, channelType = ""): Promise<Record<string, unknown>[]> {
    void channelType; // 原实现签名带 channel_type 但未参与抽取调用
    if (!messageText.trim()) return [];
    try {
      const apiKey = (process.env["ANTHROPIC_API_KEY"] ?? "").trim();
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable not set. Event extraction requires an Anthropic API key.");
      const resp = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: EXTRACTION_PROMPT,
          messages: [{ role: "user", content: messageText }],
        }),
      });
      const data = (await resp.json()) as { content?: { type: string; text?: string }[] };
      let text = (data.content ?? []).find((b) => b.type === "text")?.text?.trim() ?? "";
      // markdown 代码块剥离（对齐原实现）
      if (text.startsWith("```")) {
        text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text.slice(3);
        if (text.endsWith("```")) text = text.slice(0, -3);
        text = text.trim();
      }
      const events = JSON.parse(text);
      if (!Array.isArray(events)) return [];
      return events as Record<string, unknown>[];
    } catch (e) {
      console.error(`[vibe-server] Event extraction failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }
}
