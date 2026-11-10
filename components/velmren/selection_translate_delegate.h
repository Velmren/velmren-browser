// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#ifndef BRAVE_COMPONENTS_VELMREN_SELECTION_TRANSLATE_DELEGATE_H_
#define BRAVE_COMPONENTS_VELMREN_SELECTION_TRANSLATE_DELEGATE_H_

#include <memory>
#include <optional>
#include <string>

#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "components/touch_to_search/core/browser/contextual_search_delegate.h"

namespace network {
class SharedURLLoaderFactory;
class SimpleURLLoader;
}  // namespace network

namespace velmren {

// Adapts an explicitly requested selection translation to the native partial
// translation model. It neither consults the search provider nor sends page
// context, credentials, or a page URL to the translation service.
class SelectionTranslateDelegate final : public ContextualSearchDelegate {
 public:
  explicit SelectionTranslateDelegate(
      scoped_refptr<network::SharedURLLoaderFactory> url_loader_factory);
  ~SelectionTranslateDelegate() override;

  SelectionTranslateDelegate(const SelectionTranslateDelegate&) = delete;
  SelectionTranslateDelegate& operator=(const SelectionTranslateDelegate&) =
      delete;

  void GatherAndSaveSurroundingText(
      base::WeakPtr<ContextualSearchContext> context,
      content::WebContents* web_contents,
      SurroundingTextCallback callback) override;

  void StartSearchTermResolutionRequest(
      base::WeakPtr<ContextualSearchContext> context,
      content::WebContents* web_contents,
      SearchTermResolutionCallback callback) override;

 private:
  void OnResponse(std::string requested_source,
                  std::optional<std::string> response_body);
  void Complete(int response_code,
                const std::string& translated_text = std::string(),
                const std::string& source_language = std::string());

  scoped_refptr<network::SharedURLLoaderFactory> url_loader_factory_;
  std::unique_ptr<network::SimpleURLLoader> url_loader_;
  SearchTermResolutionCallback callback_;
  base::WeakPtrFactory<SelectionTranslateDelegate> weak_ptr_factory_{this};
};

}  // namespace velmren

#endif  // BRAVE_COMPONENTS_VELMREN_SELECTION_TRANSLATE_DELEGATE_H_
