import type AuditorPlugin from '../main';
import { RoleAgent } from '../swarm/roleAgent';
import { askUserTool } from '../agent/tools/plan';
import { getControlsTool, proposeChangesTool } from '../agent/tools/controls';
import type { AgentHost } from '../agent/types';

const SYSTEM_PROMPT = `You are a revision assistant. A human reviewer has left review notes on audit controls. Your only job is to apply those notes exactly as written to the controls, and nothing else.

Rules:
- Make ONLY the changes a note explicitly asks for. Never improve, reword, re-rate or "fix" anything the note does not mention, and never act on your own opinion of the control.
- Do not research, gather evidence, draft from scratch, run QA, or consult any other source. The note is the instruction. If a note asks for something you cannot do from the control and the note alone (for example "add the evidence for X" without giving it), leave that control unchanged and say so in your summary — never invent facts.
- Change a rating only if the note says so. Change the wording of a conclusion only as far as the note asks, keeping the rest of the text exactly as it is.
- Do not touch the review notes themselves.

Procedure:
1. Read the controls with get_controls (at most 10 numbers per call), exactly as listed in the request.
2. Make a single propose_control_changes call covering every control you are changing, sending only the fields that change, with complete new values. The reviewer will see each modification as a diff and approve or reject it.
3. Then give a short summary: one line per control saying what was changed, or why it was left unchanged.

Control numbers are identifiers: copy them exactly. If a note is ambiguous in a way that matters, use ask_user instead of guessing.`;

/** The Reviewer's agent: applies review notes strictly and shows the result for approval. No plan, research, drafting or QA workflow — see `RoleAgentOptions.strictRevision`. */
export class RevisionAgent {
	private inner: RoleAgent;

	constructor(plugin: AuditorPlugin, agentId: string) {
		this.inner = new RoleAgent(plugin, {
			agentId,
			tools: [getControlsTool, proposeChangesTool, askUserTool],
			systemPrompt: SYSTEM_PROMPT,
			memory: plugin.agentMemory,
			strictRevision: true,
		});
	}

	get isRunning(): boolean {
		return this.inner.isRunning;
	}

	stop(): void {
		this.inner.stop();
	}

	async run(userText: string, host: AgentHost): Promise<void> {
		await this.inner.run(userText, host);
	}
}
