/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { CancellationToken } from 'vs/base/common/cancellation';
import { Emitter, Event } from 'vs/base/common/event';
import { MutableDisposable, DisposableStore } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { EditorOptions, IEditorCloseEvent, IEditorMemento } from 'vs/workbench/common/editor';
import { NotebookEditorInput } from 'vs/workbench/contrib/notebook/browser/notebookEditorInput';
import { INotebookEditorViewState, NotebookViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookViewModel';
import { IEditorGroup, IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { NotebookEditorWidget } from 'vs/workbench/contrib/notebook/browser/notebookEditorWidget';
import { EditorPart } from 'vs/workbench/browser/parts/editor/editorPart';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IEditorOptions, ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { INotebookEditorWidgetService, IBorrowValue } from 'vs/workbench/contrib/notebook/browser/notebookEditorWidgetService';
import { localize } from 'vs/nls';

const NOTEBOOK_EDITOR_VIEW_STATE_PREFERENCE_KEY = 'NotebookEditorViewState';

export class NotebookEditor extends BaseEditor {
	static readonly ID: string = 'workbench.editor.notebook';
	private editorMemento: IEditorMemento<INotebookEditorViewState>;
	private readonly groupListener = this._register(new MutableDisposable());
	private _widget: IBorrowValue<NotebookEditorWidget> = { value: undefined };
	private _rootElement!: HTMLElement;
	private dimension: DOM.Dimension | null = null;
	private _widgetDisposableStore: DisposableStore = new DisposableStore();
	private readonly _onDidFocusWidget = this._register(new Emitter<void>());
	public get onDidFocus(): Event<any> { return this._onDidFocusWidget.event; }

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupService: IEditorGroupsService,
		@INotificationService private readonly notificationService: INotificationService,
		@INotebookEditorWidgetService private readonly notebookWidgetService: INotebookEditorWidgetService,
	) {
		super(NotebookEditor.ID, telemetryService, themeService, storageService);
		this.editorMemento = this.getEditorMemento<INotebookEditorViewState>(editorGroupService, NOTEBOOK_EDITOR_VIEW_STATE_PREFERENCE_KEY);
	}

	private readonly _onDidChangeModel = new Emitter<void>();
	readonly onDidChangeModel: Event<void> = this._onDidChangeModel.event;


	set viewModel(newModel: NotebookViewModel | undefined) {
		if (this._widget.value) {
			this._widget.value.viewModel = newModel;
			this._onDidChangeModel.fire();
		}
	}

	get viewModel() {
		return this._widget.value?.viewModel;
	}

	get minimumWidth(): number { return 375; }
	get maximumWidth(): number { return Number.POSITIVE_INFINITY; }

	// these setters need to exist because this extends from BaseEditor
	set minimumWidth(value: number) { /*noop*/ }
	set maximumWidth(value: number) { /*noop*/ }


	//#region Editor Core


	public get isNotebookEditor() {
		return true;
	}

	protected createEditor(parent: HTMLElement): void {
		this._rootElement = DOM.append(parent, DOM.$('.notebook-editor'));

		// this._widget.createEditor();
		this._register(this.onDidFocus(() => this._widget.value?.updateEditorFocus()));
		this._register(this.onDidBlur(() => this._widget.value?.updateEditorFocus()));
	}

	getDomNode() {
		return this._rootElement;
	}

	getControl(): NotebookEditorWidget | undefined {
		return this._widget.value;
	}

	onWillHide() {
		if (this.input instanceof NotebookEditorInput) {
			this.saveEditorViewState(this.input);
		}
		if (this.input && this._widget.value) {
			// the widget is not transfered to other editor inputs
			this._widget.value.onWillHide();
		}
		super.onWillHide();
	}

	setEditorVisible(visible: boolean, group: IEditorGroup | undefined): void {
		super.setEditorVisible(visible, group);
		this.groupListener.value = group?.onWillCloseEditor(e => this.onWillCloseEditorInGroup(e));
	}

	private onWillCloseEditorInGroup(e: IEditorCloseEvent): void {
		const editor = e.editor;
		if (!(editor instanceof NotebookEditorInput)) {
			return; // only handle files
		}

		if (editor === this.input) {
			this.saveEditorViewState(editor);
		}
	}

	focus() {
		super.focus();
		this._widget.value?.focus();
	}

	async setInput(input: NotebookEditorInput, options: EditorOptions | undefined, token: CancellationToken): Promise<void> {

		const group = this.group!;

		if (this.input instanceof NotebookEditorInput) {
			// set a new input, let's hide previous input
			this.saveEditorViewState(this.input as NotebookEditorInput);
		}

		await super.setInput(input, options, token);

		this._widgetDisposableStore.clear();

		// there currently is a widget which we still own so
		// we need to hide it before getting a new widget
		if (this._widget.value) {
			this._widget.value.onWillHide();
		}

		this._widget = this.instantiationService.invokeFunction(this.notebookWidgetService.retrieveWidget, group, input);

		if (this.dimension) {
			this._widget.value!.layout(this.dimension, this._rootElement);
		}

		const model = await input.resolve(this._widget.value!.getId());

		if (model === null) {
			this.notificationService.prompt(
				Severity.Error,
				localize('fail.noEditor', "Cannot open resource with notebook editor type '${input.viewType}', please check if you have the right extension installed or enabled."),
				[{
					label: localize('fail.reOpen', "Reopen file with VS Code standard text editor"),
					run: async () => {
						const fileEditorInput = this.editorService.createEditorInput({ resource: input.resource, forceFile: true });
						const textOptions: IEditorOptions | ITextEditorOptions = options ? { ...options, override: false } : { override: false };
						await this.editorService.openEditor(fileEditorInput, textOptions);
					}
				}]
			);
			return;
		}

		const viewState = this.loadTextEditorViewState(input);

		await this._widget.value!.setModel(model.notebook, viewState, options);
		this._widgetDisposableStore.add(this._widget.value!.onDidFocus(() => this._onDidFocusWidget.fire()));

		if (this.editorGroupService instanceof EditorPart) {
			this._widgetDisposableStore.add(this.editorGroupService.createEditorDropTarget(this._widget.value!.getDomNode(), {
				groupContainsPredicate: (group) => this.group?.id === group.group.id
			}));
		}
	}

	clearInput(): void {
		if (this._widget.value) {
			this._widget.value.onWillHide();
		}
		super.clearInput();
	}

	private saveEditorViewState(input: NotebookEditorInput): void {
		if (this.group && this._widget.value) {
			const state = this._widget.value.getEditorViewState();
			this.editorMemento.saveEditorState(this.group, input.resource, state);
		}
	}

	private loadTextEditorViewState(input: NotebookEditorInput): INotebookEditorViewState | undefined {
		if (this.group) {
			return this.editorMemento.loadEditorState(this.group, input.resource);
		}

		return;
	}

	layout(dimension: DOM.Dimension): void {
		DOM.toggleClass(this._rootElement, 'mid-width', dimension.width < 1000 && dimension.width >= 600);
		DOM.toggleClass(this._rootElement, 'narrow-width', dimension.width < 600);
		this.dimension = dimension;

		if (!this._widget.value || !(this._input instanceof NotebookEditorInput)) {
			return;
		}

		if (this._input.resource.toString() !== this._widget.value.viewModel?.uri.toString() && this._widget.value?.viewModel) {
			// input and widget mismatch
			// this happens when
			// 1. open document A, pin the document
			// 2. open document B
			// 3. close document B
			// 4. a layout is triggered
			return;
		}

		this._widget.value.layout(this.dimension, this._rootElement);
	}

	protected saveState(): void {
		if (this.input instanceof NotebookEditorInput) {
			this.saveEditorViewState(this.input);
		}

		super.saveState();
	}

	//#endregion

	//#region Editor Features

	//#endregion

	dispose() {
		super.dispose();
	}

	toJSON(): any {
		return {
			notebookHandle: this.viewModel?.handle
		};
	}
}
