// FastAPI 兼容错误：HTTPException 的响应形状是 {"detail": "..."}，前端按此解析。

export class HttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(detail);
  }
}

export type StreamWriter = { write: (chunk: string) => void };
