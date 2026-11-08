// Copyright (c) 2024 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import * as React from 'react'
import { getLocale } from '$web-common/locale'
import { SearchEngineMenu } from '$web-common/SearchEngineMenu'
import type { SearchEngineInfo } from '../../api/background'
import { useSearchContext } from './SearchContext'
import { MediumSearchEngineIcon } from './SearchEngineIcon'

export default function EnginePicker(props: { onSelectEngine: () => void }) {
  const { filteredSearchEngines, searchEngine, setSearchEngine, setOpen } =
    useSearchContext()
  return (
    <SearchEngineMenu<SearchEngineInfo>
      engines={filteredSearchEngines}
      selectedEngine={searchEngine}
      engineKey={(engine) => engine.keyword}
      engineName={(engine) =>
        engine.isDefault
          ? `${engine.name} (${getLocale('searchBrowserDefaultLabel')})`
          : engine.name
      }
      renderIcon={(engine) => <MediumSearchEngineIcon engine={engine} />}
      label={`${getLocale('searchEnginePickerLabel')}: ${searchEngine?.name ?? ''}`}
      description={getLocale('searchEngineScopeDescription')}
      customizeLabel={getLocale('searchCustomizeList')}
      browserDefaultLabel={getLocale('searchBrowserDefaultLink')}
      onSelectEngine={(engine) => {
        setSearchEngine(engine)
        props.onSelectEngine()
      }}
      onCustomizeClick={() => {
        history.pushState(undefined, '', '?openSettings=Search')
        setOpen(false)
      }}
    />
  )
}
