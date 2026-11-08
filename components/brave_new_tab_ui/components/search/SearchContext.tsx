// Copyright (c) 2024 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import { useSearchEngineSelection } from '$web-common/useSearchEngineSelection'
import { AutocompleteResult, FreState, InputKeywordModel, InputMethod, OmniboxPopupSelection, PageHandlerFactory, PageHandlerRemote, PageInterface, PageReceiver, SelectedFileInfo, SelectionDirection, SelectionStep, TabInfo } from 'chrome://resources/mojo/components/omnibox/browser/searchbox.mojom-webui.js';
import { SuggestInventory } from 'chrome://resources/mojo/components/omnibox/browser/fusebox_action.mojom-webui.js';
import * as React from 'react';
import getNTPBrowserAPI, { SearchEngineInfo } from '../../api/background';
import { useEngineContext } from './EngineContext';
import { ContextUploadErrorType, ContextUploadStatus } from 'gen/components/omnibox/composebox/composebox_query.mojom.m';
import { InputState } from 'gen/ui/webui/resources/tsc/mojo/components/omnibox/composebox/composebox_query.mojom-webui';
import { WindowOpenDisposition } from 'gen/ui/webui/resources/tsc/mojo/ui/base/mojom/window_open_disposition.mojom-webui';
import { Size } from 'gen/ui/webui/resources/tsc/mojo/ui/gfx/geometry/mojom/geometry.mojom-webui';
import { Url } from 'gen/ui/webui/resources/tsc/mojo/url/mojom/url.mojom-webui';

interface Context {
  open: boolean,
  setOpen: (open: boolean) => void,
  query: string,
  setQuery: (query: string) => void
  searchEngine?: SearchEngineInfo,
  setSearchEngine: (searchEngine: SearchEngineInfo | string) => void
  searchEngines: SearchEngineInfo[]
  filteredSearchEngines: SearchEngineInfo[]
}

const Context = React.createContext<Context>({
  open: false,
  setOpen: () => { },
  query: '',
  setQuery: () => { },
  searchEngine: undefined,
  setSearchEngine: () => { },
  searchEngines: [],
  filteredSearchEngines: []
})


export const omniboxController: PageHandlerRemote = new PageHandlerRemote();
(window as any).omnibox = omniboxController;

// Tracks the latest query sent for autocompletion. Used to filter out stale
// results.
let activeQueryId = 0;

class SearchPage implements PageInterface {
  private receiver = new PageReceiver(this)
  private result: AutocompleteResult | undefined
  private resultListeners: Array<(result?: AutocompleteResult) => void> = []
  private selectionListeners: Array<(selection: OmniboxPopupSelection) => void> = []

  constructor() {
    PageHandlerFactory.getRemote().createPageHandler(
      this.receiver.$.bindNewPipeAndPassRemote(),
      omniboxController.$.bindNewPipeAndPassReceiver(),
    )
  }

  addResultListener(listener: (result?: AutocompleteResult) => void) {
    this.resultListeners.push(listener)
    if (this.result) listener(this.result)
  }

  removeResultListener(listener: (result?: AutocompleteResult) => void) {
    this.resultListeners = this.resultListeners.filter(r => r !== listener)
  }

  addSelectionListener(listener: (selection: OmniboxPopupSelection) => void) {
    this.selectionListeners.push(listener)
  }

  removeSelectionListener(listener: (selection: OmniboxPopupSelection) => void) {
    this.selectionListeners = this.selectionListeners.filter(s => s !== listener)
  }

  autocompleteResultChanged(result: AutocompleteResult) {
    if (result.queryId !== activeQueryId - 1) return
    this.result = result;
    for (const listener of this.resultListeners) listener(result)
  }

  clearResults() {
    ++activeQueryId
    this.result = undefined
    for (const listener of this.resultListeners) listener(undefined)
  }

  updateSelection(selection: OmniboxPopupSelection) {
    for (const listener of this.selectionListeners) listener(selection)
  }

  onShow(): void { }
  setInputText(inputText: string) { }
  setThumbnail(thumbnailUrl: string) { }
  onContextualInputStatusChanged(token: string, status: ContextUploadStatus, errorType: ContextUploadErrorType | null) { }
  setKeywordSpaceTriggeringEnabled(enabled: boolean): void { }
  setAvailableKeywordModels(models: InputKeywordModel[]): void { }
  onTabStripChanged() { }
  addFileContext(token: string, fileInfo: SelectedFileInfo) { }
  setKeywordSelected(isKeywordSelected: boolean): void {}
  updateAutoSuggestedTabContext(tab: (TabInfo | null)): void {}
  updateLensSearchEligibility(eligible: boolean): void {}
  updateContentSharingPolicy(enabled: boolean): void {}
  onInputStateChanged(inputState: InputState): void {}
  stepSelection(direction: SelectionDirection, step: SelectionStep): void {}
  openCurrentSelection(disposition: WindowOpenDisposition): void {}
  setAimButtonVisible(visible: boolean): void {}
  updateAimPopupEligibility(eligible: boolean): void {}
  onPermissionPromptChanged(isShowing: boolean, promptSize: Size): void {}
  setRestoredTabIds(tabIds: number[]): void { }
  setAimThreadRestoredTabs(tabs: TabInfo[]): void { }
  updateSmartTabSharingActive(active: boolean): void { }
  setAimButtonConfig(text: string, tooltip: string, a11yLabel: string, iconUrl: Url): void { }
  resetPopupToInitialState(): void { }
  onScreenshotMenuClosed(): void { }
  setFreState(state: FreState): void { }
  updateProfileInfo(avatarUrl: string, name: string, email: string): void { }
}

export const search = new SearchPage()

export function SearchContext(props: React.PropsWithChildren<{}>) {
  const { engineConfig, searchEngines } = useEngineContext()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const { engine: searchEngine, options: filteredSearchEngines, selectEngine } =
    useSearchEngineSelection(searchEngines, (host) => !!engineConfig[host])

  const setSearchEngine = React.useCallback((engine: SearchEngineInfo | string) => {
    const selected = typeof engine === 'string'
      ? searchEngines.find((entry) => entry.host === engine || entry.keyword === engine)
      : engine
    if (selected) selectEngine(selected)
  }, [searchEngines, selectEngine])

  React.useEffect(() => {
    getNTPBrowserAPI().newTabMetrics.reportNTPSearchDefaultEngine(searchEngine?.prepopulateId ?? null)
  }, [searchEngine?.prepopulateId])

  // A committed query/provider must not retain suggestions from the last one.
  React.useLayoutEffect(() => search.clearResults(), [query, searchEngine])

  // When the query changes, notify the browser side.
  React.useEffect(() => {
    if (query) {
      const keywordQuery = searchEngine?.keyword ? `${searchEngine.keyword} ${query}` : query
      omniboxController.queryAutocomplete(activeQueryId++, null, keywordQuery, false, keywordQuery.length, SuggestInventory.kDefault, false, '', InputMethod.kKeyboard);
    } else {
      search.clearResults()
      omniboxController.stopAutocomplete(true)
    }
  }, [query, searchEngine])

  const setQueryExternal = React.useCallback((query: string) => {
    setOpen(true)
    setQuery(query)
  }, [])

  const context = React.useMemo(() => ({
    open,
    setOpen,
    searchEngine,
    setSearchEngine,
    query,
    setQuery: setQueryExternal,
    searchEngines,
    filteredSearchEngines
  }), [searchEngine, setSearchEngine, filteredSearchEngines, query, searchEngines, open])

  return <Context.Provider value={context}>
    {props.children}
  </Context.Provider>
}

export function useSearchContext() {
  return React.useContext(Context)
}
