// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import { act, renderHook } from '@testing-library/react'
import { useSearchEngineSelection } from './useSearchEngineSelection'

const google = { keyword: 'google', host: 'www.google.com', isDefault: true }
const yandex = { keyword: 'yandex', host: 'yandex.com', isDefault: false }
const bing = { keyword: 'bing', host: 'bing.com', isDefault: false }

describe('NTP search engine selection', () => {
  it('follows browser default even with an old Yandex-only widget list', () => {
    localStorage.setItem('last-search-engine', yandex.host)
    const { result, rerender } = renderHook(
      ({ engines }) =>
        useSearchEngineSelection(engines, (host) => host === yandex.host),
      { initialProps: { engines: [google, yandex, bing] } },
    )
    expect(result.current.engine).toEqual(google)
    expect(result.current.options).toEqual([google, yandex])
    rerender({
      engines: [
        { ...google, isDefault: false },
        yandex,
        { ...bing, isDefault: true },
      ],
    })
    expect(result.current.engine?.keyword).toBe(bing.keyword)
    expect(result.current.options.map((entry) => entry.keyword)).toEqual([
      'yandex',
      'bing',
    ])
  })

  it('keeps alternatives local to this tab and resets on a browser default change', () => {
    const { result, rerender, unmount } = renderHook(
      ({ engines }) => useSearchEngineSelection(engines, () => true),
      { initialProps: { engines: [google, yandex, bing] } },
    )
    act(() => result.current.selectEngine(yandex))
    expect(result.current.engine).toEqual(yandex)
    rerender({
      engines: [
        { ...google, isDefault: false },
        yandex,
        { ...bing, isDefault: true },
      ],
    })
    expect(result.current.engine?.keyword).toBe(bing.keyword)
    unmount()
    const nextTab = renderHook(() =>
      useSearchEngineSelection([google, yandex], () => true),
    )
    expect(nextTab.result.current.engine).toEqual(google)
  })

  it('does not change provider when merely enabling another menu item', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useSearchEngineSelection([google, yandex], (host) => enabled.has(host)),
      { initialProps: { enabled: new Set<string>() } },
    )
    rerender({ enabled: new Set([yandex.host]) })
    expect(result.current.engine).toEqual(google)
    act(() => result.current.selectEngine(yandex))
    rerender({ enabled: new Set() })
    expect(result.current.engine).toEqual(google)
    rerender({ enabled: new Set([yandex.host]) })
    expect(result.current.engine).toEqual(google)
  })

  it('preserves an exact custom default with the same host as another provider', () => {
    const custom = { ...google, keyword: 'custom-google' }
    const { result } = renderHook(() =>
      useSearchEngineSelection(
        [{ ...google, isDefault: false }, custom],
        () => true,
      ),
    )
    expect(result.current.engine).toEqual(custom)
    act(() => result.current.selectEngine({ ...google, isDefault: false }))
    expect(result.current.engine?.keyword).toBe(google.keyword)
  })
})
