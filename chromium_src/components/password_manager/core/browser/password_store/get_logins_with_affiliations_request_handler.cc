/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "components/password_manager/core/browser/password_store/get_logins_with_affiliations_request_handler.h"

#include <algorithm>
#include <string_view>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/types/expected.h"
#include "build/build_config.h"
#include "components/affiliations/core/browser/match_type.h"
#include "components/password_manager/core/browser/password_form.h"
#include "components/password_manager/core/browser/password_store/stored_credential.h"
#include "url/gurl.h"
#include "url/origin.h"

#if BUILDFLAG(IS_WIN)
#define GetLoginsWithAffiliationsRequestHandler \
  GetLoginsWithAffiliationsRequestHandler_ChromiumImpl
#endif

#include <components/password_manager/core/browser/password_store/get_logins_with_affiliations_request_handler.cc>

#if BUILDFLAG(IS_WIN)
#undef GetLoginsWithAffiliationsRequestHandler

namespace password_manager {
namespace {

constexpr char kImportedGoogleRealm[] = "https://google.com/";

using ImportedGoogleLoginsResult =
    base::expected<std::vector<StoredCredential>, PasswordStoreBackendError>;

bool HasCanonicalGoogleOrigin(const GURL& url, std::string_view realm) {
  return url.is_valid() && url.SchemeIs("https") && !url.has_port() &&
         !url.has_username() && !url.has_password() &&
         url::Origin::Create(url).GetURL().spec() == realm;
}

bool SupportsImportedGoogleCredentials(const PasswordFormDigest& digest) {
  return digest.scheme == PasswordForm::Scheme::kHtml &&
         (digest.signon_realm == "https://accounts.google.com/" ||
          digest.signon_realm == "https://myaccount.google.com/") &&
         HasCanonicalGoogleOrigin(digest.url, digest.signon_realm);
}

bool IsUsableHtmlPassword(const StoredCredential& credential) {
  return credential.scheme == PasswordForm::Scheme::kHtml &&
         !credential.blocked_by_user &&
         !credential.federation_origin.IsValid() &&
         !credential.password_value.empty();
}

bool IsImportedGoogleCredential(const StoredCredential& credential) {
  return credential.type == PasswordForm::Type::kImported &&
         IsUsableHtmlPassword(credential) &&
         credential.signon_realm == kImportedGoogleRealm &&
         HasCanonicalGoogleOrigin(credential.url, kImportedGoogleRealm);
}

void AppendImportedGoogleCredentials(
    std::vector<StoredCredential> ordinary_credentials,
    LoginsOrErrorReply callback,
    ImportedGoogleLoginsResult imported_credentials) {
  // An optional compatibility query must not hide successful ordinary results.
  if (imported_credentials) {
    for (auto& credential : *imported_credentials) {
      if (!IsImportedGoogleCredential(credential)) {
        continue;
      }
      const bool already_matched = std::ranges::any_of(
          ordinary_credentials, [&credential](const auto& existing) {
            return (existing.match_type == affiliations::MatchType::kExact &&
                    IsUsableHtmlPassword(existing) &&
                    existing.username_value == credential.username_value) ||
                   AreStoredCredentialUniqueKeysEqual(existing, credential);
          });
      if (!already_matched) {
        credential.match_type = affiliations::MatchType::kAffiliated;
        ordinary_credentials.push_back(std::move(credential));
      }
    }
  }
  std::move(callback).Run(std::move(ordinary_credentials));
}

void MaybeGetImportedGoogleCredentials(
    base::WeakPtr<PasswordStoreBackend> backend,
    LoginsOrErrorReply callback,
    ImportedGoogleLoginsResult ordinary_credentials) {
  if (!ordinary_credentials || !backend) {
    std::move(callback).Run(std::move(ordinary_credentials));
    return;
  }
  backend->FillMatchingLoginsAsync(
      base::BindOnce(&AppendImportedGoogleCredentials,
                     std::move(*ordinary_credentials), std::move(callback)),
      /*include_psl=*/false,
      {PasswordFormDigest(PasswordForm::Scheme::kHtml, kImportedGoogleRealm,
                          GURL(kImportedGoogleRealm))});
}

}  // namespace

void GetLoginsWithAffiliationsRequestHandler(
    PasswordFormDigest form,
    PasswordStoreBackend* backend,
    AffiliatedMatchHelper* affiliated_match_helper,
    LoginsOrErrorReply callback) {
  // Yandex CSV imports can identify Google accounts by the root domain. Bridge
  // only these imported credentials to Google's two account origins, keeping
  // Chromium's deliberate Google PSL exclusion and stored identities intact.
  if (SupportsImportedGoogleCredentials(form)) {
    callback = base::BindOnce(&MaybeGetImportedGoogleCredentials,
                              backend->AsWeakPtr(), std::move(callback));
  }
  GetLoginsWithAffiliationsRequestHandler_ChromiumImpl(
      std::move(form), backend, affiliated_match_helper, std::move(callback));
}

}  // namespace password_manager

#endif  // BUILDFLAG(IS_WIN)
