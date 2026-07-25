import { CONTROL_RATINGS, CONTROL_STATUSES, type ControlRecord } from './controlNote';

interface FieldHelpers {
	textField: (label: string, get: () => string, set: (v: string) => void) => void;
	textArea: (label: string, rows: number, get: () => string, set: (v: string) => void) => void;
	dropdown: (label: string, options: string[], get: () => string, set: (v: string) => void) => void;
	/** A label+input pair sized to its content instead of taking the full row width, for short fields. */
	compactField: (label: string, get: () => string, set: (v: string) => void) => void;
	/** A label+select pair sized to its content, for short dropdowns. */
	compactDropdown: (label: string, options: string[], get: () => string, set: (v: string) => void) => void;
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
	const textArea: FieldHelpers['textArea'] = (label, rows, get, set) => {
		const wrap = field(label, 'auditor-field-full');
		const textarea = wrap.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		textarea.rows = rows;
		textarea.value = get();
		textarea.addEventListener('input', () => { set(textarea.value); onChange(); });
	};
	const dropdown: FieldHelpers['dropdown'] = (label, options, get, set) => {
		const wrap = field(label, 'auditor-field-full');
		const select = wrap.createEl('select');
		for (const opt of options) {
			const optionEl = select.createEl('option', { text: opt || '(none)', value: opt });
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
	return { textField, textArea, dropdown, compactField, compactDropdown };
}

export function renderGeneralFields(container: HTMLElement, record: ControlRecord, onChange: () => void = () => {}): void {
	const { textArea } = createFieldHelpers(container, onChange);

	const compactGrid = container.createDiv('auditor-compact-grid');
	const { compactField, compactDropdown } = createFieldHelpers(compactGrid, onChange);
	compactField('Control number', () => record.number, (v) => { record.number = v; });
	compactField('Standard', () => record.standard, (v) => { record.standard = v; });
	compactField('Topic', () => record.topic, (v) => { record.topic = v; });
	compactField('Session', () => record.session, (v) => { record.session = v; });
	compactField('Assigned member', () => record.assignedMember, (v) => { record.assignedMember = v; });
	compactDropdown('Status', CONTROL_STATUSES.includes(record.status) ? CONTROL_STATUSES : [record.status, ...CONTROL_STATUSES], () => record.status, (v) => { record.status = v; });

	textArea('Control', 4, () => record.control, (v) => { record.control = v; });
	textArea('Comments', 3, () => record.comments, (v) => { record.comments = v; });
}

export function renderStage1Fields(container: HTMLElement, record: ControlRecord, onChange: () => void = () => {}): void {
	const { textArea, dropdown } = createFieldHelpers(container, onChange);
	textArea('Finding', 8, () => record.todFinding, (v) => { record.todFinding = v; });
	textArea('Recommendation', 5, () => record.todRecommendation, (v) => { record.todRecommendation = v; });
	dropdown('ToD rating', CONTROL_RATINGS, () => record.todRating, (v) => { record.todRating = v as ControlRecord['todRating']; });
}

export function renderStage2Fields(container: HTMLElement, record: ControlRecord, onChange: () => void = () => {}): void {
	const { textArea, dropdown } = createFieldHelpers(container, onChange);
	textArea('Finding', 8, () => record.toeFinding, (v) => { record.toeFinding = v; });
	textArea('Recommendation', 5, () => record.toeRecommendation, (v) => { record.toeRecommendation = v; });
	dropdown('ToE rating', CONTROL_RATINGS, () => record.toeRating, (v) => { record.toeRating = v as ControlRecord['toeRating']; });
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
