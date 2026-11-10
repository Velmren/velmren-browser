// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/velmren/selection_translate_delegate.h"

#include <string_view>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/strings/escape.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "base/values.h"
#include "components/translate/core/common/translate_constants.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_status_code.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "net/url_request/referrer_policy.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace velmren {
namespace {

// This web endpoint requires no API key. Its errors (including throttling or a
// changed response format) are surfaced by the existing native error UI.
constexpr char kEndpoint[] =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=";
constexpr size_t kMaxResponseBytes = 256 * 1024;
constexpr base::TimeDelta kRequestTimeout = base::Seconds(20);

bool IsLanguageCode(std::string_view code) {
  if (code.size() < 2 || code.size() > 35 || code.front() == '-' ||
      code.back() == '-') {
    return false;
  }
  bool previous_hyphen = false;
  for (char character : code) {
    if (character == '-') {
      if (previous_hyphen) {
        return false;
      }
      previous_hyphen = true;
    } else {
      if (!base::IsAsciiAlphaNumeric(character)) {
        return false;
      }
      previous_hyphen = false;
    }
  }
  return true;
}

bool IsKnownLanguageCode(std::string_view code) {
  return IsLanguageCode(code) && code != "auto" && code != "und";
}

std::optional<std::u16string> GetSelection(
    const ContextualSearchContext& context) {
  const int start = context.GetStartOffset();
  const int end = context.GetEndOffset();
  const auto& surroundings = context.GetSurroundingText();
  if (!context.CanResolve() ||
      context.GetRequestType() !=
          ContextualSearchContext::RequestType::PARTIAL_TRANSLATE ||
      start < 0 || end <= start ||
      static_cast<size_t>(end) > surroundings.size() ||
      end - start >
          translate::kDesktopPartialTranslateTextSelectionMaxCharacters) {
    return std::nullopt;
  }
  std::u16string selection = surroundings.substr(start, end - start);
  if (base::TrimWhitespace(selection, base::TRIM_ALL).empty()) {
    return std::nullopt;
  }
  return selection;
}

}  // namespace

SelectionTranslateDelegate::SelectionTranslateDelegate(
    scoped_refptr<network::SharedURLLoaderFactory> url_loader_factory)
    : url_loader_factory_(std::move(url_loader_factory)) {}

SelectionTranslateDelegate::~SelectionTranslateDelegate() = default;

void SelectionTranslateDelegate::GatherAndSaveSurroundingText(
    base::WeakPtr<ContextualSearchContext> context,
    content::WebContents* web_contents,
    SurroundingTextCallback callback) {
  // PartialTranslateManager supplies the selection itself. Never ask a renderer
  // for additional page content, even if this unused interface method is
  // called.
  const auto selection = context ? GetSelection(*context) : std::nullopt;
  callback.Run(context ? context->GetBasePageEncoding() : std::string(),
               selection.value_or(std::u16string()), 0,
               selection ? selection->size() : 0);
}

void SelectionTranslateDelegate::StartSearchTermResolutionRequest(
    base::WeakPtr<ContextualSearchContext> context,
    content::WebContents* web_contents,
    SearchTermResolutionCallback callback) {
  // A superseding native translation drops the previous callback. Closing the
  // bubble destroys this delegate and its loader, cancelling the request too.
  weak_ptr_factory_.InvalidateWeakPtrs();
  url_loader_.reset();
  callback_ = std::move(callback);

  const auto selection = context ? GetSelection(*context) : std::nullopt;
  if (!selection || !url_loader_factory_) {
    Complete(0);
    return;
  }
  const auto& languages = context->GetTranslationLanguages();
  if (!IsKnownLanguageCode(languages.target_language)) {
    Complete(0);
    return;
  }
  // The first request's source hint is the page language, which can differ from
  // the selected message's language (for example English text in Russian chat).
  const std::string source =
      !context->GetApplyLangHint() &&
              IsKnownLanguageCode(languages.detected_language)
          ? languages.detected_language
          : "auto";
  const GURL url(
      base::StrCat({kEndpoint, source, "&tl=", languages.target_language,
                    "&dt=t&ie=UTF-8&oe=UTF-8"}));

  auto request = std::make_unique<network::ResourceRequest>();
  request->url = url;
  request->method = "POST";
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->redirect_mode = network::mojom::RedirectMode::kError;
  request->referrer_policy = net::ReferrerPolicy::NO_REFERRER;
  request->load_flags = net::LOAD_DISABLE_CACHE;

  constexpr auto kTrafficAnnotation =
      net::DefineNetworkTrafficAnnotation("velmren_selection_translate", R"(
        semantics {
          sender: "Selected text translation"
          description:
            "Translates only text explicitly selected by the user, using "
            "Google Translate. The page URL and surrounding content are not "
            "sent. This request is independent of the default search engine."
          trigger:
            "The user chooses Translate for selected text in the context menu "
            "or changes a language in the native selection translation bubble."
          data: "Selected text and source/target language codes."
          destination: GOOGLE_OWNED_SERVICE
          user_data { type: WEB_CONTENT }
          last_reviewed: "2026-11-10"
        }
        policy {
          cookies_allowed: NO
          setting:
            "Controlled by translation settings. Requests happen only after "
            "an explicit selection translation action."
          chrome_policy {
            TranslateEnabled { TranslateEnabled: false }
          }
        })");

  url_loader_ =
      network::SimpleURLLoader::Create(std::move(request), kTrafficAnnotation);
  url_loader_->SetTimeoutDuration(kRequestTimeout);
  // Reject all redirects explicitly as well as in ResourceRequest, so selected
  // text cannot be forwarded to another destination or placed in a redirect
  // URL.
  url_loader_->SetOnRedirectCallback(base::BindRepeating(
      [](base::WeakPtr<SelectionTranslateDelegate> delegate, const GURL&,
         const net::RedirectInfo&, const network::mojom::URLResponseHead&,
         std::vector<std::string>*) {
        if (delegate) {
          delegate->Complete(0);
        }
      },
      weak_ptr_factory_.GetWeakPtr()));
  url_loader_->AttachStringForUpload(
      base::StrCat({"q=", base::EscapeUrlEncodedData(
                              base::UTF16ToUTF8(*selection), true)}),
      "application/x-www-form-urlencoded; charset=UTF-8");
  url_loader_->DownloadToString(
      url_loader_factory_.get(),
      base::BindOnce(&SelectionTranslateDelegate::OnResponse,
                     weak_ptr_factory_.GetWeakPtr(), source),
      kMaxResponseBytes);
}

void SelectionTranslateDelegate::OnResponse(
    std::string requested_source,
    std::optional<std::string> response_body) {
  int response_code = 0;
  if (url_loader_->ResponseInfo() && url_loader_->ResponseInfo()->headers) {
    response_code = url_loader_->ResponseInfo()->headers->response_code();
  }
  if (url_loader_->NetError() != net::OK || response_code != net::HTTP_OK ||
      !response_body) {
    Complete(response_code == net::HTTP_OK ? 0 : response_code);
    return;
  }

  auto response =
      base::JSONReader::ReadList(*response_body, base::JSON_PARSE_RFC);
  if (!response || response->empty() || !(*response)[0].is_list() ||
      (*response)[0].GetList().empty()) {
    Complete(0);
    return;
  }
  std::string translated_text;
  for (const auto& segment : (*response)[0].GetList()) {
    if (!segment.is_list() || segment.GetList().empty() ||
        !segment.GetList()[0].is_string()) {
      Complete(0);
      return;
    }
    translated_text += segment.GetList()[0].GetString();
  }
  std::string detected_source;
  if (response->size() > 2 && (*response)[2].is_string()) {
    detected_source = (*response)[2].GetString();
  }
  if (!IsKnownLanguageCode(detected_source) && requested_source != "auto") {
    detected_source = requested_source;
  }
  if (translated_text.empty() || !IsKnownLanguageCode(detected_source)) {
    // The native manager considers every HTTP 200 a success, so malformed
    // successful responses must become an error code before reaching it.
    Complete(0);
    return;
  }
  // This remains plain text. The native bubble displays a Label, not HTML.
  Complete(net::HTTP_OK, translated_text, detected_source);
}

void SelectionTranslateDelegate::Complete(int response_code,
                                          const std::string& translated_text,
                                          const std::string& source_language) {
  weak_ptr_factory_.InvalidateWeakPtrs();
  url_loader_.reset();
  auto callback = std::move(callback_);
  if (!callback) {
    return;
  }
  const ResolvedSearchTerm result(
      response_code != net::HTTP_OK, response_code,
      /*search_term=*/"", /*display_text=*/"", /*alternate_term=*/"",
      /*mid=*/"", /*prevent_preload=*/true, /*selection_start_adjust=*/0,
      /*selection_end_adjust=*/0, source_language, /*thumbnail_url=*/"",
      translated_text, /*quick_action_uri=*/"", QUICK_ACTION_CATEGORY_NONE,
      /*search_url_full=*/"", /*search_url_preload=*/"", /*coca_card_tag=*/0,
      /*related_searches_json=*/"");
  // The callback may synchronously destroy this delegate and its owning bubble.
  callback.Run(result);
}

}  // namespace velmren
