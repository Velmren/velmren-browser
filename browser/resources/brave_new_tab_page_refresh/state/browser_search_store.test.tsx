// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import * as React from 'react'
import { act, renderHook } from '@testing-library/react'
import { createSearchStore } from './browser_search_store'
import { NewTabPageProxy } from './new_tab_page_proxy'
import { SearchBoxProxy } from './search_box_proxy'
import { SearchContext } from '../context/search_context'
import { useSearchInputState } from '../components/search/search_input_state'
import type { AutocompleteResult } from 'chrome://resources/mojo/components/omnibox/browser/searchbox.mojom-webui.js'

// Transport bindings are unavailable in Jest; only query text is under test.
jest.mock(
  'chrome://resources/mojo/components/omnibox/browser/searchbox.mojom-webui.js',
  () => ({ InputMethod: {} }),
)
jest.mock(
  'chrome://resources/mojo/components/omnibox/browser/fusebox_action.mojom-webui.js',
  () => ({ SuggestInventory: {} }),
)
jest.mock('./new_tab_page_proxy', () => ({
  NewTabPageProxy: { getInstance: jest.fn() },
}))
jest.mock('./search_box_proxy', () => ({
  SearchBoxProxy: { getInstance: jest.fn() },
}))
jest.mock('$web-common/loadTimeData', () => ({
  loadTimeData: { getBoolean: () => true, getString: () => 'search.brave.com' },
}))

const google = {
  prepopulateId: BigInt(1),
  name: 'Google',
  host: 'www.google.com',
  keyword: 'google',
  faviconUrl: '',
  isDefault: true,
}
const yandex = {
  prepopulateId: BigInt(2),
  name: 'Yandex',
  host: 'yandex.com',
  keyword: 'yandex',
  faviconUrl: '',
  isDefault: false,
}

function mockProxies() {
  let updated: () => void = () => {}
  let resultChanged: (result: AutocompleteResult) => void = () => {}
  const newTab = {
    handler: {
      getAvailableSearchEngines: jest
        .fn()
        .mockResolvedValue({ searchEngines: [google, yandex] }),
      getShowSearchBox: jest.fn().mockResolvedValue({ showSearchBox: true }),
      getShowChatInput: jest.fn().mockResolvedValue({ showChatInput: false }),
      getSearchSuggestionsEnabled: jest
        .fn()
        .mockResolvedValue({ enabled: false }),
      getSearchSuggestionsPromptDismissed: jest
        .fn()
        .mockResolvedValue({ dismissed: false }),
      getLastUsedSearchEngine: jest
        .fn()
        .mockResolvedValue({ engine: yandex.host }),
      setLastUsedSearchEngine: jest.fn(),
      openSearch: jest.fn(),
      reportSearchEngineUsage: jest.fn(),
      reportSearchBoxHidden: jest.fn(),
    },
    addListeners: jest.fn((listeners: { onSearchStateUpdated: () => void }) => {
      updated = listeners.onSearchStateUpdated
    }),
    update: () => updated(),
  }
  const search = {
    handler: { queryAutocomplete: jest.fn(), stopAutocomplete: jest.fn() },
    addListeners: jest.fn(
      (listeners: { autocompleteResultChanged: typeof resultChanged }) => {
        resultChanged = listeners.autocompleteResultChanged
      },
    ),
    resultChanged: (result: AutocompleteResult) => resultChanged(result),
  }
  ;(NewTabPageProxy.getInstance as jest.Mock).mockReturnValue(newTab)
  ;(SearchBoxProxy.getInstance as jest.Mock).mockReturnValue(search)
  return { newTab, search }
}

describe('browser search state integration', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    localStorage.setItem(
      'search-engines',
      JSON.stringify({ [yandex.host]: true }),
    )
  })
  afterEach(() => {
    jest.useRealTimers()
    localStorage.clear()
  })

  it('uses the normal browser default for initial dispatch, and reacts to native changes', async () => {
    const { newTab, search } = mockProxies()
    const store = createSearchStore()
    await jest.runOnlyPendingTimersAsync()
    const wrapper = ({ children }: React.PropsWithChildren<{}>) => (
      <SearchContext.Provider value={store}>{children}</SearchContext.Provider>
    )
    const { result } = renderHook(() => useSearchInputState('search-box'), {
      wrapper,
    })
    expect(result.current.searchEngine?.name).toBe('Google')
    expect(store.getState().lastUsedSearchEngine).toBe(yandex.host)
    act(() => result.current.setQuery('red panda habitat'))
    const click = {
      button: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }
    act(() => result.current.openSearch(click))
    expect(newTab.handler.openSearch).toHaveBeenLastCalledWith(
      'red panda habitat',
      'google',
      click,
    )
    expect(search.handler.queryAutocomplete.mock.calls.at(-1)[2]).toBe(
      'google red panda habitat',
    )

    const custom = {
      ...google,
      name: 'Custom Google',
      keyword: 'custom-google',
      prepopulateId: BigInt(0),
    }
    newTab.handler.getAvailableSearchEngines.mockResolvedValue({
      searchEngines: [{ ...google, isDefault: false }, yandex, custom],
    })
    await act(async () => {
      newTab.update()
      await jest.runOnlyPendingTimersAsync()
    })
    expect(result.current.searchEngine?.keyword).toBe('custom-google')
    act(() => result.current.openSearch(click))
    expect(newTab.handler.openSearch).toHaveBeenLastCalledWith(
      'red panda habitat',
      'custom-google',
      click,
    )
    expect(newTab.handler.setLastUsedSearchEngine).not.toHaveBeenCalled()
  })

  it('keeps enabled choices and explicit per-tab overrides separate from browser default', async () => {
    const { newTab } = mockProxies()
    const store = createSearchStore()
    await jest.runOnlyPendingTimersAsync()
    const wrapper = ({ children }: React.PropsWithChildren<{}>) => (
      <SearchContext.Provider value={store}>{children}</SearchContext.Provider>
    )
    const { result } = renderHook(() => useSearchInputState('search-box'), {
      wrapper,
    })
    act(() =>
      store.getState().actions.setSearchEngineEnabled(yandex.host, true),
    )
    expect(result.current.searchEngine?.keyword).toBe('google')
    act(() => result.current.selectSearchEngine(yandex))
    expect(result.current.searchEngine?.keyword).toBe('yandex')
    expect(
      store.getState().searchEngines.find((engine) => engine.isDefault)
        ?.keyword,
    ).toBe('google')
    expect(newTab.handler.setLastUsedSearchEngine).not.toHaveBeenCalled()
  })

  it('drops late autocomplete matches from the previous provider', async () => {
    const { search } = mockProxies()
    const store = createSearchStore()
    await jest.runOnlyPendingTimersAsync()
    const actions = store.getState().actions
    actions.queryAutocomplete('red panda habitat', 'google')
    const oldQueryId = search.handler.queryAutocomplete.mock.calls.at(-1)[0]
    const response = {
      queryId: oldQueryId,
      sequenceId: 1,
      matches: [
        { destinationUrl: 'https://www.google.com/search?q=red+panda+habitat' },
      ],
    } as AutocompleteResult
    search.resultChanged(response)
    expect(store.getState().searchMatches).toHaveLength(1)
    actions.queryAutocomplete('red panda habitat', 'yandex')
    expect(store.getState().searchMatches).toHaveLength(0)
    search.resultChanged(response)
    expect(store.getState().searchMatches).toHaveLength(0)
    const currentQueryId = search.handler.queryAutocomplete.mock.calls.at(-1)[0]
    search.resultChanged({ ...response, queryId: currentQueryId })
    expect(store.getState().searchMatches).toHaveLength(1)
    actions.stopAutocomplete()
    search.resultChanged({ ...response, queryId: currentQueryId })
    expect(store.getState().searchMatches).toHaveLength(0)
  })

  it('removes the singleton optional engine while retaining the browser default', async () => {
    const { newTab } = mockProxies()
    const store = createSearchStore()
    await jest.runOnlyPendingTimersAsync()
    const wrapper = ({ children }: React.PropsWithChildren<{}>) => (
      <SearchContext.Provider value={store}>{children}</SearchContext.Provider>
    )
    const { result } = renderHook(() => useSearchInputState('search-box'), {
      wrapper,
    })
    expect([...store.getState().enabledSearchEngines]).toEqual([yandex.host])
    act(() => result.current.selectSearchEngine(yandex))
    act(() => {
      store.getState().actions.setSearchEngineEnabled(yandex.host, false)
      jest.runAllTicks()
    })
    expect(store.getState().enabledSearchEngines.size).toBe(0)
    expect(localStorage.getItem('search-engines')).toBe('{}')
    expect(result.current.searchEngineOptions).toEqual([google])
    expect(result.current.searchEngine).toEqual(google)

    await act(async () => {
      newTab.update()
      await jest.runOnlyPendingTimersAsync()
    })
    expect(result.current.searchEngineOptions).toEqual([google])
    expect(result.current.searchEngine).toEqual(google)
  })

  it.each([google, yandex])(
    'preserves suggestions and pending responses when reselecting $name',
    async (engine) => {
      const { newTab, search } = mockProxies()
      newTab.handler.getSearchSuggestionsEnabled.mockResolvedValue({
        enabled: true,
      })
      const store = createSearchStore()
      await jest.runOnlyPendingTimersAsync()
      const wrapper = ({ children }: React.PropsWithChildren<{}>) => (
        <SearchContext.Provider value={store}>{children}</SearchContext.Provider>
      )
      const { result } = renderHook(() => useSearchInputState('search-box'), {
        wrapper,
      })
      act(() => result.current.selectSearchEngine(engine))
      act(() => result.current.setActiveInput())
      act(() => result.current.setQuery('red panda habitat'))
      const queryId = search.handler.queryAutocomplete.mock.calls.at(-1)[0]
      const response = {
        queryId,
        sequenceId: 1,
        matches: [
          {
            destinationUrl: `https://${engine.host}/search?q=red+panda+habitat`,
            allowedToBeDefaultMatch: true,
          },
        ],
      } as AutocompleteResult
      act(() => {
        search.resultChanged(response)
        jest.runAllTicks()
      })
      expect(result.current.searchEngine?.keyword).toBe(engine.keyword)
      expect(result.current.resultOptions).toHaveLength(1)
      search.handler.stopAutocomplete.mockClear()
      search.handler.queryAutocomplete.mockClear()

      act(() => result.current.selectSearchEngine(engine))
      expect(search.handler.stopAutocomplete).not.toHaveBeenCalled()
      expect(search.handler.queryAutocomplete).not.toHaveBeenCalled()
      expect(store.getState().searchMatches).toEqual(response.matches)
      expect(result.current.resultOptions).toHaveLength(1)
      expect(result.current.selectedResultOption).toBe(0)

      act(() => {
        search.resultChanged({ ...response, sequenceId: 2 })
        jest.runAllTicks()
      })
      expect(store.getState().searchResultSequenceId).toBe(2)
      expect(result.current.resultOptions).toHaveLength(1)
    },
  )
})
