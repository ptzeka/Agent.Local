import { describe, it, expect } from "@jest/globals";
import {
  WORKFLOW_JOB,
  WORKFLOW_COMPLETED,
  WORKFLOW_FAILED,
  AGENT_RESULT,
} from "../events.js";

// locks the wire names siblings publish/subscribe to: a rename here is a cross-workspace breaking change
describe("event taxonomy", () => {
  it("pins the shared event names", () => {
    expect(WORKFLOW_JOB).toBe("workflow.job");
    expect(WORKFLOW_COMPLETED).toBe("workflow.completed");
    expect(WORKFLOW_FAILED).toBe("workflow.failed");
    expect(AGENT_RESULT).toBe("agent.result");
  });
});
