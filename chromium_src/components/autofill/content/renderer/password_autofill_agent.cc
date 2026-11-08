/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "build/build_config.h"
#include "components/autofill/core/common/autocomplete_parsing_util.h"
#include "components/autofill/core/common/password_form_fill_data.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_form_element.h"
#include "third_party/blink/public/web/web_input_element.h"
#include "third_party/blink/public/web/web_node.h"
#include "url/gurl.h"

#if BUILDFLAG(IS_WIN)
namespace autofill {
bool HasExplicitUsernameRole(std::string_view autocomplete);
void SetSelectedAccountForSuggestionRequest(
    const blink::WebInputElement& password,
    PasswordSuggestionRequest& request);
}  // namespace autofill
#define BRAVE_PASSWORD_AUTOFILL_AGENT_SUGGESTION_REQUEST \
  SetSelectedAccountForSuggestionRequest(user_input, request);
#define BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_ROLE \
  HasExplicitUsernameRole(autocomplete_attribute)
#define BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_INPUT_RECORDED \
  username_first_reported_fields_.insert(GetFieldRendererId(element));
#define BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_FIRST_RESET \
  username_first_reported_fields_.clear();
#define BRAVE_PASSWORD_AUTOFILL_AGENT_REJECTED_USERNAME_VALUE               \
  if (username_first_reported_fields_.erase(GetFieldRendererId(element))) { \
    if (auto* driver = unsafe_driver()) {                                   \
      driver->UserModifiedNonPasswordField(                                 \
          GetFieldRendererId(element), std::u16string(),                    \
          HasExplicitUsernameRole(autocomplete_attribute),                  \
          password_manager::util::IsLikelyOtp(name_attribute, id_attribute, \
                                              autocomplete_attribute));     \
    }                                                                       \
  }
#else
#define BRAVE_PASSWORD_AUTOFILL_AGENT_SUGGESTION_REQUEST
#define BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_ROLE \
  autocomplete_attribute.contains(                  \
      password_manager::constants::kAutocompleteUsername)
#define BRAVE_PASSWORD_AUTOFILL_AGENT_REJECTED_USERNAME_VALUE
#define BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_INPUT_RECORDED
#define BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_FIRST_RESET
#endif

#include <components/autofill/content/renderer/password_autofill_agent.cc>

#undef BRAVE_PASSWORD_AUTOFILL_AGENT_SUGGESTION_REQUEST
#undef BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_ROLE
#undef BRAVE_PASSWORD_AUTOFILL_AGENT_REJECTED_USERNAME_VALUE
#undef BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_INPUT_RECORDED
#undef BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_FIRST_RESET

#if BUILDFLAG(IS_WIN)
namespace autofill {

bool HasExplicitUsernameRole(std::string_view autocomplete) {
  // Autofill maps both email and username to kEmail; retain the actual role
  // token while reusing its full section/type-hint syntax validation.
  if (!ParseAutocompleteAttribute(autocomplete)) {
    return false;
  }
  auto tokens =
      base::SplitStringPiece(autocomplete, base::kWhitespaceASCII,
                             base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
  if (!tokens.empty() &&
      base::EqualsCaseInsensitiveASCII(tokens.back(), "webauthn")) {
    tokens.pop_back();
  }
  return !tokens.empty() &&
         base::EqualsCaseInsensitiveASCII(tokens.back(), "username");
}

namespace {

std::optional<std::u16string> VisibleSelectedAccountText(
    const blink::WebElement& marker) {
  std::u16string text;
  size_t visited = 0;
  for (blink::WebNode node = marker; node;) {
    if (++visited > 128) {
      return std::nullopt;
    }
    auto element = node.DynamicTo<blink::WebElement>();
    if (element &&
        (element.GetComputedValue("display") == "none" ||
         element.GetComputedValue("visibility") != "visible" ||
         element.GetComputedValue("content-visibility") == "hidden" ||
         element.GetComputedValue("opacity") == "0" ||
         element.GetAttribute("aria-hidden") == "true")) {
      node = node.NextSkippingChildrenInFlatTree(marker);
      continue;
    }
    if (node.IsTextNode()) {
      text += node.NodeValue().Utf16();
      if (text.size() > 1024) {
        return std::nullopt;
      }
    }
    node = node.NextInFlatTree(marker);
  }
  return std::u16string(base::TrimWhitespace(text, base::TRIM_ALL));
}

}  // namespace

void SetSelectedAccountForSuggestionRequest(
    const blink::WebInputElement& password,
    PasswordSuggestionRequest& request) {
  if (!password.IsConnected() ||
      password.FormControlTypeForAutofill() !=
          blink::mojom::FormControlType::kInputPassword) {
    return;
  }
  const auto document = password.GetDocument();
  const auto password_form = password.Form();
  bool conflicting = false;
  const auto add_username = [&](std::u16string value) {
    if (value.empty() || value.size() > 1024 ||
        (request.selected_username && *request.selected_username != value)) {
      conflicting = true;
    }
    request.selected_username = std::move(value);
  };

  // Hidden inputs are deliberately omitted from Autofill's FormData. Capture
  // their explicit role separately without adding them to filling candidates.
  for (const auto& element : document.QuerySelectorAll("input[autocomplete]")) {
    const auto input = element.DynamicTo<blink::WebInputElement>();
    if (!input || input.Form() != password_form ||
        input.FormControlType() !=
            blink::mojom::FormControlType::kInputHidden) {
      continue;
    }
    if (HasExplicitUsernameRole(input.GetAttribute("autocomplete").Utf8())) {
      add_username(input.Value().Utf16());
    }
  }

  // A selected account chip can sit above the form. Bind it only when this
  // document has one visible password field, and never inspect arbitrary text
  // or an account chooser's list of data-email entries.
  size_t visible_passwords = 0;
  for (const auto& element : document.QuerySelectorAll("input")) {
    const auto input = element.DynamicTo<blink::WebInputElement>();
    if (input && input.IsFocusable() &&
        input.FormControlTypeForAutofill() ==
            blink::mojom::FormControlType::kInputPassword &&
        !input.VisibleBoundsInWidget().IsEmpty()) {
      ++visible_passwords;
    }
  }
  if (visible_passwords == 1 && password.IsFocusable() &&
      !password.VisibleBoundsInWidget().IsEmpty()) {
    const GURL document_url(document.Url());
    const bool is_google_signin =
        document_url.SchemeIs("https") &&
        document_url.host() == "accounts.google.com" &&
        !document_url.has_port();
    for (auto marker : document.QuerySelectorAll(
             "#selected-account, #current-account, [data-selected-account], "
             "[data-current-account], [aria-current='true'][data-email], "
             "#profileIdentifier")) {
      if (marker.GetComputedValue("visibility") != "visible" ||
          (marker.GetAttribute("id") == "profileIdentifier" &&
           !is_google_signin)) {
        continue;
      }
      auto ancestor = blink::WebNode(marker);
      bool other_form = false;
      bool hidden = false;
      for (; ancestor; ancestor = ancestor.ParentNode()) {
        auto element = ancestor.DynamicTo<blink::WebElement>();
        if (element &&
            (element.GetAttribute("aria-hidden") == "true" ||
             element.GetComputedValue("opacity") == "0" ||
             element.GetComputedValue("display") == "none" ||
             element.GetComputedValue("visibility") != "visible" ||
             element.GetComputedValue("content-visibility") == "hidden")) {
          hidden = true;
        }
        const auto enclosing_form = ancestor.DynamicTo<blink::WebFormElement>();
        if (enclosing_form) {
          other_form |= enclosing_form != password_form;
        }
      }
      if (other_form || hidden) {
        continue;
      }
      // An empty current chip is a negative signal, even if its empty box has
      // no area. Hidden stale chips above are ignored instead.
      if (marker.VisibleBoundsInWidget().IsEmpty()) {
        add_username(std::u16string());
        continue;
      }
      const auto visible_text = VisibleSelectedAccountText(marker);
      std::u16string username;
      if (marker.HasAttribute("data-email")) {
        username = marker.GetAttribute("data-email").Utf16();
      } else if (marker.HasAttribute("data-identifier")) {
        username = marker.GetAttribute("data-identifier").Utf16();
      } else if (is_google_signin &&
                 marker.GetAttribute("id") == "profileIdentifier") {
        username = visible_text.value_or(std::u16string());
      }
      // Attribute and visible chip text must agree, including letter case.
      if (!visible_text || visible_text->empty() || *visible_text != username) {
        conflicting = true;
      }
      add_username(std::move(username));
    }
  }
  if (conflicting) {
    request.selected_username = std::u16string();
  }
}

}  // namespace autofill
#endif  // BUILDFLAG(IS_WIN)
