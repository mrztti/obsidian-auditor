import type { AgentHost } from '../agent/types';
import { findControlsTool, getControlsTool } from '../agent/tools/controls';
import { recallMemoryTool, rememberFactTool } from '../agent/tools/memory';
import { updatePlanTool } from '../agent/tools/plan';
import type AuditorPlugin from '../main';
import { AgentMemoryStore } from '../agent/memory';
import { dispatchSwarmTool, getSwarmStatusTool, stopSwarmTool } from './coordinatorTools';
import { buildCoordinatorPrompt } from './prompts';
import { RoleAgent } from './roleAgent';

export const COORDINATOR_AGENT_ID = 'coordinator';

/**
 * The conversational front end for the swarm — a thin wrapper over `RoleAgent`, the same way
 * `agent/agent.ts`'s `ChatAgent` is, just with the coordinator's own tool subset/prompt/memory
 * instead of the full chat registry. Replaces the one-shot `SwarmLaunchModal`: the user talks to
 * this the way they'd talk to the chat agent, and `dispatch_swarm` does the actual launching.
 */
export class CoordinatorAgent {
	private inner: RoleAgent;

	constructor(plugin: AuditorPlugin) {
		this.inner = new RoleAgent(plugin, {
			agentId: COORDINATOR_AGENT_ID,
			tools: [updatePlanTool, findControlsTool, getControlsTool, dispatchSwarmTool, getSwarmStatusTool, stopSwarmTool, recallMemoryTool, rememberFactTool],
			systemPrompt: buildCoordinatorPrompt(),
			memory: new AgentMemoryStore(plugin, COORDINATOR_AGENT_ID),
		});
	}

	get isRunning(): boolean {
		return this.inner.isRunning;
	}

	getSummary(): string {
		return this.inner.getSummary();
	}

	reset(): void {
		this.inner.reset();
	}

	stop(): void {
		this.inner.stop();
	}

	steer(text: string): void {
		this.inner.steer(text);
	}

	async run(userText: string, host: AgentHost, isBurnModeEnabled: () => boolean = () => false): Promise<void> {
		await this.inner.run(userText, host, isBurnModeEnabled);
	}
}
