/** fetch 工具的稳定错误码载体（与具体传输实现解耦，避免循环依赖）。 */
export class FetchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FetchError";
  }
}
