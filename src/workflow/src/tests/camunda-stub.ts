// test stub for @camunda8/sdk: ZeebeClient takes an injected gRPC in tests, so the SDK is never exercised here
// the real @camunda8/sdk resolves at integration once the workspace is wired into the root install
export class Camunda8 {
  getZeebeGrpcApiClient(): unknown {
    throw new Error("camunda-stub: inject a gRPC client in tests");
  }
}
