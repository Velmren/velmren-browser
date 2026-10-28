/* Copyright (c) 2025 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "components/regional_capabilities/regional_capabilities_utils.h"

#include <algorithm>

#include "base/check.h"
#include "base/check_op.h"
#include "base/containers/fixed_flat_map.h"
#include "base/containers/map_util.h"
#include "base/containers/span.h"
#include "brave/components/search_engines/brave_prepopulated_engines.h"
#include "components/prefs/pref_service.h"

// Use Brave's lists of per-country engines.
#define GetPrepopulatedEngines GetPrepopulatedEngines_UnUsed
#include <components/regional_capabilities/regional_capabilities_utils.cc>
#undef GetPrepopulatedEngines

namespace regional_capabilities {

namespace {

// ****************************************************************************
// IMPORTANT! If you make changes to any of the search engine mappings below,
// it's critical to also increment the value `kBraveCurrentDataVersion` in
// `brave/components/search_engines/brave_prepopulated_engines.h`.
// ****************************************************************************

// Default order in which engines will appear in the UI.
// LINT.IfChange
constexpr TemplateURLPrepopulateData::BravePrepopulatedEngineID
    kBraveEnginesDefault[] = {
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BRAVE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_DUCKDUCKGO,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_QWANT,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BING,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_STARTPAGE,
};
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// Variations of the order / default options by country.
// LINT.IfChange
constexpr TemplateURLPrepopulateData::BravePrepopulatedEngineID
    kBraveEnginesWithEcosia[] = {
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BRAVE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_DUCKDUCKGO,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_QWANT,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BING,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_STARTPAGE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_ECOSIA,
};
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// LINT.IfChange
constexpr TemplateURLPrepopulateData::BravePrepopulatedEngineID
    kBraveEnginesWithYandex[] = {
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_YANDEX,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BRAVE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_DUCKDUCKGO,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_QWANT,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BING,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_STARTPAGE,
};
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// LINT.IfChange
constexpr TemplateURLPrepopulateData::BravePrepopulatedEngineID
    kBraveEnginesDE[] = {
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BRAVE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_DUCKDUCKGO_DE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_QWANT,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BING,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_STARTPAGE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_ECOSIA,
};
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// LINT.IfChange
constexpr TemplateURLPrepopulateData::BravePrepopulatedEngineID
    kBraveEnginesFR[] = {
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BRAVE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_QWANT,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_DUCKDUCKGO,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BING,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_STARTPAGE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_ECOSIA,
};
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// LINT.IfChange
constexpr TemplateURLPrepopulateData::BravePrepopulatedEngineID
    kBraveEnginesAUIE[] = {
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BRAVE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_DUCKDUCKGO_AU_NZ_IE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_QWANT,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BING,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_STARTPAGE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_ECOSIA,
};
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// LINT.IfChange
constexpr TemplateURLPrepopulateData::BravePrepopulatedEngineID
    kBraveEnginesJP[] = {
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_YAHOO_JP,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BRAVE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_DUCKDUCKGO,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_QWANT,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BING,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_STARTPAGE,
};
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// LINT.IfChange
constexpr TemplateURLPrepopulateData::BravePrepopulatedEngineID
    kBraveEnginesKR[] = {
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BRAVE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_NAVER,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_DAUM,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE,
};
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// LINT.IfChange
constexpr TemplateURLPrepopulateData::BravePrepopulatedEngineID
    kBraveEnginesNZ[] = {
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BRAVE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_DUCKDUCKGO_AU_NZ_IE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_QWANT,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_BING,
        TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_STARTPAGE,
};
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// A map to keep track of a full list of default engines for countries
// that don't use the default list.
// LINT.IfChange
constexpr auto kDefaultEnginesByCountryIdMap = base::MakeFixedFlatMap<
    country_codes::CountryId,
    base::span<const TemplateURLPrepopulateData::BravePrepopulatedEngineID>>(
    {{country_codes::CountryId("AM"), kBraveEnginesWithYandex},
     {country_codes::CountryId("AT"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("AU"), kBraveEnginesAUIE},
     {country_codes::CountryId("AZ"), kBraveEnginesWithYandex},
     {country_codes::CountryId("BE"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("BY"), kBraveEnginesWithYandex},
     {country_codes::CountryId("CA"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("CH"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("DE"), kBraveEnginesDE},
     {country_codes::CountryId("DK"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("ES"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("FI"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("FR"), kBraveEnginesFR},
     {country_codes::CountryId("GB"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("GR"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("HU"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("IE"), kBraveEnginesAUIE},
     {country_codes::CountryId("IT"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("JP"), kBraveEnginesJP},
     {country_codes::CountryId("KG"), kBraveEnginesWithYandex},
     {country_codes::CountryId("KR"), kBraveEnginesKR},
     {country_codes::CountryId("KZ"), kBraveEnginesWithYandex},
     {country_codes::CountryId("LU"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("MD"), kBraveEnginesWithYandex},
     {country_codes::CountryId("NL"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("NO"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("NZ"), kBraveEnginesNZ},
     {country_codes::CountryId("PT"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("RU"), kBraveEnginesWithYandex},
     {country_codes::CountryId("SE"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("TJ"), kBraveEnginesWithYandex},
     {country_codes::CountryId("TM"), kBraveEnginesWithYandex},
     {country_codes::CountryId("US"), kBraveEnginesWithEcosia},
     {country_codes::CountryId("UZ"), kBraveEnginesWithYandex}});
// LINT.ThenChange(//brave/components/search_engines/brave_prepopulated_engines.h:kBraveCurrentDataVersion)

// Builds a vector of PrepulatedEngine objects from the given array of
// |engine_ids|.
std::vector<raw_ptr<const TemplateURLPrepopulateData::PrepopulatedEngine>>
GetEnginesFromEngineIDs(
    base::span<const TemplateURLPrepopulateData::BravePrepopulatedEngineID>
        engine_ids) {
  std::vector<raw_ptr<const TemplateURLPrepopulateData::PrepopulatedEngine>>
      engines;
  for (TemplateURLPrepopulateData::BravePrepopulatedEngineID engine_id :
       engine_ids) {
    const auto* engine = base::FindPtrOrNull(
        TemplateURLPrepopulateData::kBraveEngines, engine_id);
    CHECK(engine);
    engines.push_back(engine);
  }
  return engines;
}

// Uses brave_engines_XX localized arrays of engine IDs instead of Chromium's
// localized arrays of PrepopulatedEngines to construct the vector of
// TemplateURLData.
std::vector<raw_ptr<const TemplateURLPrepopulateData::PrepopulatedEngine>>
GetBravePrepopulatedEnginesForCountryID(country_codes::CountryId country_id) {
  base::span<const TemplateURLPrepopulateData::BravePrepopulatedEngineID>
      brave_engine_ids = kBraveEnginesDefault;

  // Check for a per-country override of this list
  const auto* country_engines =
      base::FindOrNull(kDefaultEnginesByCountryIdMap, country_id);
  if (country_engines) {
    brave_engine_ids = *country_engines;
  }
  DCHECK_GT(brave_engine_ids.size(), 0ul);

  // Build a vector PrepopulatedEngines from
  // TemplateURLPrepopulateData::BravePrepopulatedEngineIDs.
  std::vector<raw_ptr<const TemplateURLPrepopulateData::PrepopulatedEngine>>
      engines = GetEnginesFromEngineIDs(brave_engine_ids);
  DCHECK(engines.size() == brave_engine_ids.size());

  // Keep Yandex available even when the detected region is outside the CIS.
  const auto* yandex = &TemplateURLPrepopulateData::brave_yandex;
  if (std::ranges::find(engines, yandex) == engines.end()) {
    engines.push_back(yandex);
  }
  const auto* preferred = country_id == country_codes::CountryId("RU")
                              ? yandex
                              : &TemplateURLPrepopulateData::brave_google;
  auto preferred_it = std::ranges::find(engines, preferred);
  if (preferred_it != engines.end()) {
    std::rotate(engines.begin(), preferred_it, preferred_it + 1);
  }
  return engines;
}

}  // namespace

std::vector<raw_ptr<const TemplateURLPrepopulateData::PrepopulatedEngine>>
GetPrepopulatedEngines(CountryId country_id,
                       PrefService& prefs,
                       SearchEngineListType search_engine_list_type) {
  return GetBravePrepopulatedEnginesForCountryID(country_id);
}

TemplateURLPrepopulateData::BravePrepopulatedEngineID GetDefaultEngine(
    CountryId country_id,
    PrefService& prefs) {
  // Regional fallback only; explicit user, policy and extension choices win
  // in DefaultSearchManager. Desktop market shares: September 2026.
  return country_id == country_codes::CountryId("RU")
             ? TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_YANDEX
             : TemplateURLPrepopulateData::PREPOPULATED_ENGINE_ID_GOOGLE;
}

}  // namespace regional_capabilities
