import { Notice } from 'obsidian';
import type AuditorPlugin from '../main';
import { RunView } from '../agent/chatPanel';
import type { AgentHost } from '../agent/types';
import { formatUsageLine } from '../agent/usage';
import type { ReviewerData } from './reviewerData';
import { RevisionAgent } from './revisionAgent';

let launchCounter = 0;

/** The request that sends the revision agent through every selected control's review notes. */
function buildApplyPrompt(items: { number: string; notes: string }[]): string {
	const blocks = items.map((i, n) => `${n + 1}. Control ${i.number}\nReviewer notes:\n${i.notes.trim()}`);
	return [
		`Apply the following review notes to ${items.length === 1 ? 'this control' : `these ${items.length} controls`}, strictly as written, and nothing else.`,
		'',
		blocks.join('\n\n'),
	].join('\n');
}

/**
 * The Reviewer's third tab: lists the review-set controls that have notes, and launches an agent
 * that applies those notes strictly (no drafting workflow). Its proposed modifications are shown as
 * diffs, and nothing is saved without the user's approval of each one.
 */
export class ApplyTab {
	private listEl: HTMLElement;
	private runArea: HTMLElement;
	private launchBtn!: HTMLButtonElement;
	private agent: RevisionAgent | null = null;
	private run: RunView | null = null;
	private excluded = new Set<string>();

	constructor(private root: HTMLElement, private plugin: AuditorPlugin, private data: ReviewerData) {
		this.listEl = root.createDiv('auditor-rv-apply-list');
		this.runArea = root.createDiv('auditor-rv-apply-run');
		data.onChange(() => { if (!this.agent?.isRunning) this.renderList(); });
		this.renderList();
	}

	dispose(): void {
		this.run?.cancelPending('The Reviewer was closed.');
		this.agent?.stop();
	}

	/** Review-set controls that have notes — the ones an agent can act on. */
	private withNotes(): { number: string; notes: string; topic: string }[] {
		return this.data.reviewSet().flatMap((number) => {
			const r = this.data.get(number)?.record;
			return r && r.reviewNotes.trim() ? [{ number, notes: r.reviewNotes, topic: r.topic }] : [];
		});
	}

	renderList(): void {
		this.listEl.empty();
		const all = this.withNotes();
		const header = this.listEl.createDiv('auditor-rv-apply-header');
		header.createEl('h3', { text: 'Apply review notes', cls: 'auditor-rv-apply-title' });
		const missing = this.data.reviewSet().length - all.length;
		header.createDiv({
			text: all.length === 0
				? 'None of the controls to review have notes yet.'
				: `${all.length} control${all.length === 1 ? ' has' : 's have'} notes${missing > 0 ? ` · ${missing} without notes are skipped` : ''}.`,
			cls: 'auditor-field-description',
		});

		const scroll = this.listEl.createDiv('auditor-rv-apply-scroll');
		for (const item of all) {
			const row = scroll.createEl('label', { cls: 'auditor-rv-apply-row' });
			const box = row.createEl('input', { type: 'checkbox' });
			box.checked = !this.excluded.has(item.number);
			box.addEventListener('change', () => {
				if (box.checked) this.excluded.delete(item.number);
				else this.excluded.add(item.number);
				this.updateLaunch();
			});
			const text = row.createDiv('auditor-rv-apply-row-text');
			text.createDiv({ text: item.topic ? `${item.number} · ${item.topic}` : item.number, cls: 'auditor-rv-apply-row-title' });
			text.createDiv({ text: item.notes.trim(), cls: 'auditor-rv-apply-row-notes' });
		}

		this.launchBtn = this.listEl.createEl('button', { cls: 'mod-cta auditor-rv-apply-launch' });
		this.launchBtn.addEventListener('click', () => { void this.launch(); });
		this.updateLaunch();
	}

	private selected(): { number: string; notes: string }[] {
		return this.withNotes().filter((i) => !this.excluded.has(i.number));
	}

	private updateLaunch(): void {
		const n = this.selected().length;
		const busy = this.agent?.isRunning ?? false;
		this.launchBtn.disabled = n === 0 || busy;
		this.launchBtn.setText(busy ? 'Agent is working…' : `Launch agent on ${n} control${n === 1 ? '' : 's'}`);
	}

	private async launch(): Promise<void> {
		const items = this.selected();
		if (items.length === 0 || this.agent?.isRunning) return;
		if (!this.plugin.settings.geminiApiKey) {
			new Notice('Auditor: add your Gemini API key in the plugin settings first.');
			return;
		}
		const agent = new RevisionAgent(this.plugin, `reviewer-${++launchCounter}`);
		this.agent = agent;
		this.runArea.empty();
		const scroll = () => { this.runArea.scrollTo({ top: this.runArea.scrollHeight, behavior: 'smooth' }); };
		const run = new RunView(this.runArea, this.plugin, () => {
			run.cancelPending('The user stopped the run.');
			run.setStatus('Stopping…');
			agent.stop();
		}, scroll);
		this.run = run;
		const sessionLine = this.runArea.createDiv('auditor-chat-session-usage auditor-agent-hidden');
		this.updateLaunch();

		const host: AgentHost = {
			emit: (event) => {
				if (event.type === 'plan') run.renderPlan(event.plan);
				else if (event.type === 'note') run.addNote(event.text);
				else if (event.type === 'tool_start') run.toolStart(event.id, event.label, event.burn);
				else if (event.type === 'tool_end') run.toolEnd(event.id, event.ok, event.summary);
				else if (event.type === 'usage') {
					run.updateUsage(event.stepId, event.usage, event.runTotals);
					sessionLine.removeClass('auditor-agent-hidden');
					sessionLine.setText(`Session: ${formatUsageLine(event.sessionTotals)}`);
				}
				else if (event.type === 'context') run.updateContext(event.usage);
				else if (event.type === 'compaction') run.noteCompaction(event.beforeTokens, event.afterTokens, event.duplicatesRemoved, event.elided);
				else run.finish(event);
			},
			requestApproval: (proposal) => run.showProposal(proposal),
			reportApplied: (outcomes) => run.showApplied(outcomes),
			requestCheckpoint: (info) => run.showCheckpoint(info),
			requestErrorRecovery: (info) => run.showErrorRecovery(info),
		};
		try {
			await agent.run(buildApplyPrompt(items), host);
		} finally {
			this.updateLaunch();
		}
		this.renderCompletion(items.map((i) => i.number));
	}

	/** Offered once a run has ended: tidy up the controls it covered. Each action is separate and can be used once. */
	private renderCompletion(numbers: string[]): void {
		const card = this.runArea.createDiv('auditor-rv-complete');
		card.createEl('h4', { text: 'Review complete', cls: 'auditor-rv-section' });
		const count = `${numbers.length} control${numbers.length === 1 ? '' : 's'}`;
		const row = card.createDiv('auditor-rv-complete-actions');

		const clearNotes = row.createEl('button', { text: `Clear review notes (${count})` });
		clearNotes.addEventListener('click', () => {
			clearNotes.disabled = true;
			void (async () => {
				for (const number of numbers) await this.data.save(number, { reviewNotes: '' });
				clearNotes.setText('Review notes cleared');
				new Notice(`Auditor: cleared the review notes of ${count}.`);
			})();
		});

		const removeFromList = row.createEl('button', { text: `Remove from review list (${count})` });
		removeFromList.addEventListener('click', () => {
			removeFromList.disabled = true;
			const done = new Set(numbers);
			void this.data.setReviewSet(this.data.reviewSet().filter((n) => !done.has(n))).then(() => {
				removeFromList.setText('Removed from review list');
			});
		});
		this.runArea.scrollTo({ top: this.runArea.scrollHeight, behavior: 'smooth' });
	}
}
