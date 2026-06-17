import { type Eventing, wireCamundaMesh } from "@agent-local/common";

// wire the camunda mesh onto the host bus: it correlates each workflow.job to a session and emits
// agent.job for the agent worker to pick up. Pure to the bus. Returns a teardown that clears the maps.
export function wireCamunda(bus: Eventing): () => void {
  return wireCamundaMesh(bus);
}
