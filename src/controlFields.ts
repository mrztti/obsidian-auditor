import { CONTROL_RATINGS, CONTROL_STATUSES, todayIsoDate, type ControlComment, type ControlRecord } from './controlNote';

interface FieldHelpers {
	textField: (label: string, get: () => string, set: (v: string) => void) => void;
	/** `growable`: the field wrap and textarea flex to fill any leftover height in their (flex-column) parent and scroll internally, instead of sizing purely from `rows` — used by the Findings tab so its two conclusion boxes always fill the exact view height. */
	textArea: (label: string, rows: number, get: () => string, set: (v: string) => void, growable?: boolean) => void;
	dropdown: (label: string, options: string[], get: () => string, set: (v: string) => void) => void;
	/** A label+input pair sized to its content instead of taking the full row width, for short fields. */
	compactField: (label: string, get: () => string, set: (v: string) => void) => void;
	/** A label+select pair sized to its content, for short dropdowns. */
	compactDropdown: (label: string, options: string[], get: () => string, set: (v: string) => void) => void;
	/** A single checkbox+label pair on one line. */
	checkboxField: (label: string, get: () => boolean, set: (v: boolean) => void) => void;
	/** Renders the full comment history (date + text, oldest first) plus an "Add comment" box that appends a new dated entry — comments are never edited or removed in place, only added to. */
	commentsField: (label: string, get: () => ControlComment[], add: (text: string) => void) => void;
}

/** Builds field-rendering helpers bound to `container`, each firing `onChange` after every edit. Every field uses the same small-uppercase-label styling for visual consistency, whether full-width or compact. */
export function createFieldHelpers(container: HTMLElement, onChange: () => void): FieldHelpers {
	const field = (label: string, cls: string): HTMLElement => {
		const wrap = container.createDiv(`auditor-field ${cls}`);
		wrap.createEl('label', { text: label, cls: 'auditor-field-label' });
		return wrap;
	};
	const textField: FieldHelpers['textField'] = (label, get, set) => {
		const wrap = field(label, 'auditor-field-full');
		const input = wrap.createEl('input', { type: 'text' });
		input.value = get();
		input.addEventListener('input', () => { set(input.value); onChange(); });
	};
	const textArea: FieldHelpers['textArea'] = (label, rows, get, set, growable = false) => {
		const wrap = field(label, `auditor-field-full${growable ? ' auditor-field-textarea-grow' : ''}`);
		const textarea = wrap.createEl('textarea', { cls: `auditor-pipeline-textarea${growable ? ' auditor-textarea-grow' : ''}` });
		textarea.rows = rows;
		textarea.value = get();
		textarea.addEventListener('input', () => { set(textarea.value); onChange(); });
	};
	const dropdown: FieldHelpers['dropdown'] = (label, options, get, set) => {
		const wrap = field(label, 'auditor-field-full');
		const select = wrap.createEl('select');
		for (const opt of options) {
			const optionEl = select.createEl('option', { text: opt === '-' ? 'N/A (-)' : opt || '(none)', value: opt });
			if (opt === get()) optionEl.selected = true;
		}
		select.addEventListener('change', () => { set(select.value); onChange(); });
	};
	const compactField: FieldHelpers['compactField'] = (label, get, set) => {
		const wrap = field(label, 'auditor-field-compact');
		const input = wrap.createEl('input', { type: 'text' });
		input.value = get();
		input.addEventListener('input', () => { set(input.value); onChange(); });
	};
	const compactDropdown: FieldHelpers['compactDropdown'] = (label, options, get, set) => {
		const wrap = field(label, 'auditor-field-compact');
		const select = wrap.createEl('select');
		for (const opt of options) {
			const optionEl = select.createEl('option', { text: opt || '(none)', value: opt });
			if (opt === get()) optionEl.selected = true;
		}
		select.addEventListener('change', () => { set(select.value); onChange(); });
	};
	const checkboxField: FieldHelpers['checkboxField'] = (label, get, set) => {
		const wrap = container.createDiv('auditor-field auditor-field-checkbox');
		const checkboxLabel = wrap.createEl('label', { cls: 'auditor-checkbox-label' });
		const checkbox = checkboxLabel.createEl('input', { type: 'checkbox' });
		checkbox.checked = get();
		checkboxLabel.createSpan({ text: label });
		checkbox.addEventListener('change', () => { set(checkbox.checked); onChange(); });
	};
	const commentsField: FieldHelpers['commentsField'] = (label, get, add) => {
		const wrap = field(label, 'auditor-field-full');
		const list = wrap.createDiv('auditor-comments-list');
		const renderList = () => {
			list.empty();
			const comments = get();
			if (comments.length === 0) {
				list.createEl('p', { text: 'No comments yet.', cls: 'auditor-field-description' });
				return;
			}
			for (const comment of comments) {
				const item = list.createDiv('auditor-comment-item');
				if (comment.date) item.createSpan({ text: comment.date, cls: 'auditor-comment-date' });
				item.createSpan({ text: comment.text, cls: 'auditor-comment-text' });
			}
		};
		renderList();
		const addRow = wrap.createDiv('auditor-comment-add-row');
		const input = addRow.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		input.rows = 2;
		input.placeholder = 'Add a comment… (Cmd/Ctrl+Enter to submit)';
		const addBtn = addRow.createEl('button', { text: 'Add comment' });
		const submit = () => {
			const text = input.value.trim();
			if (!text) return;
			add(text);
			input.value = '';
			renderList();
			onChange();
		};
		addBtn.addEventListener('click', submit);
		input.addEventListener('keydown', (evt) => {
			if ((evt.metaKey || evt.ctrlKey) && evt.key === 'Enter') {
				evt.preventDefault();
				submit();
			}
		});
	};
	return { textField, textArea, dropdown, compactField, compactDropdown, checkboxField, commentsField };
}

/**
 * @param onCommentAdded Fired right after a comment is appended, in addition to `onChange` — callers
 * that persist immediately (e.g. `ControlDetailView`) use this to auto-save just the comment, without
 * requiring the user to separately hit "Save" for the rest of the form.
 */
export function renderGeneralFields(
	container: HTMLElement,
	record: ControlRecord,
	onChange: () => void = () => {},
	onCommentAdded: () => void = () => {},
): void {
	const { textArea, commentsField } = createFieldHelpers(container, onChange);

	const compactGrid = container.createDiv('auditor-compact-grid');
	const { compactField, compactDropdown } = createFieldHelpers(compactGrid, onChange);
	compactField('Control number', () => record.number, (v) => { record.number = v; });
	compactField('Standard', () => record.standard, (v) => { record.standard = v; });
	compactField('Topic', () => record.topic, (v) => { record.topic = v; });
	compactField('Session', () => record.session, (v) => { record.session = v; });
	compactField('Assigned member', () => record.assignedMember, (v) => { record.assignedMember = v; });
	compactDropdown('Status', CONTROL_STATUSES.includes(record.status) ? CONTROL_STATUSES : [record.status, ...CONTROL_STATUSES], () => record.status, (v) => { record.status = v; });

	textArea('Control', 4, () => record.control, (v) => { record.control = v; });
	commentsField('Comments', () => record.comments, (text) => {
		record.comments.push({ date: todayIsoDate(), text });
		onCommentAdded();
	});
}

export function renderStage1Fields(container: HTMLElement, record: ControlRecord, onChange: () => void = () => {}, growable = false): void {
	const { textArea, dropdown, checkboxField } = createFieldHelpers(container, onChange);
	textArea('Conclusion', 12, () => record.todConclusion, (v) => { record.todConclusion = v; }, growable);
	dropdown('ToD rating', CONTROL_RATINGS, () => record.todRating, (v) => { record.todRating = v as ControlRecord['todRating']; });
	checkboxField('Conclusion ready', () => record.todReady, (v) => { record.todReady = v; });
}

export function renderStage2Fields(container: HTMLElement, record: ControlRecord, onChange: () => void = () => {}, growable = false): void {
	const { textArea, dropdown, checkboxField } = createFieldHelpers(container, onChange);
	textArea('Conclusion', 12, () => record.toeConclusion, (v) => { record.toeConclusion = v; }, growable);
	dropdown('ToE rating', CONTROL_RATINGS, () => record.toeRating, (v) => { record.toeRating = v as ControlRecord['toeRating']; });
	checkboxField('Conclusion ready', () => record.toeReady, (v) => { record.toeReady = v; });
}

/** Renders every field of a control record in one flat column (used by the linear drafting pipeline). */
export function renderControlRecordFields(container: HTMLElement, record: ControlRecord): void {
	renderGeneralFields(container, record);
	// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToD" is a literal acronym used in the report format
	container.createEl('h4', { text: 'Test of design (Stage 1)', cls: 'auditor-field-section-heading' });
	renderStage1Fields(container, record);
	// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToE" is a literal acronym used in the report format
	container.createEl('h4', { text: 'Test of effectiveness (Stage 2)', cls: 'auditor-field-section-heading' });
	renderStage2Fields(container, record);
}
