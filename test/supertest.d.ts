export interface TestResponse<T = any> {
  body: T;
  status: number;
  headers: Record<string, string>;
  text: string;
}
export interface Test {
  expect(status: number): Test;
  send(body: unknown): Test;
  set(field: string, value: string): Test;
  then<T1 = TestResponse, T2 = never>(
    onfulfilled?: ((value: TestResponse) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2>;
  catch<T = never>(
    onrejected?: ((reason: any) => T | PromiseLike<T>) | null,
  ): Promise<TestResponse | T>;
}
export interface Agent {
  get(url: string): Test;
  post(url: string): Test;
  put(url: string): Test;
}
declare function request(app: unknown): Agent;
export default request;
