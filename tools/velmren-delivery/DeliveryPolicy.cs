using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Velmren.Delivery;

internal sealed record DeliveryPolicy(string Mode, int Schema, string Product, string? Channel,
    string? Platform, string? FeedUri, string[] AllowedRedirectHosts)
{
    [JsonIgnore]
    public bool IsRelease => Mode == "Release";

    internal static DeliveryPolicy LoadEmbedded()
    {
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("Velmren.DeliveryPolicy")
            ?? throw new InvalidOperationException("Missing embedded delivery policy.");
        var policy = JsonSerializer.Deserialize<DeliveryPolicy>(resource, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
        }) ?? throw new InvalidDataException("Invalid delivery policy.");
#if RELEASE_DELIVERY
        policy.Validate("Release");
#else
        policy.Validate("Development");
#endif
        return policy;
    }

    internal void Validate(string expectedMode)
    {
        if (Mode != expectedMode || AllowedRedirectHosts is null)
            throw new InvalidDataException("Delivery policy does not match the compiled build mode.");
        if (!IsRelease)
        {
            if (Mode != "Development" || Schema != 1 || Product != "velmren-local-development"
                || Channel is not null || Platform is not null || FeedUri is not null || AllowedRedirectHosts.Length != 0)
                throw new InvalidDataException("Invalid development policy.");
            return;
        }
        if (Schema != 2 || Product != "velmren" || Channel != "preview" || Platform != "win-x64")
            throw new InvalidDataException("Invalid release product, channel, platform or schema.");
        var feed = ParseUri(FeedUri);
        ValidateHttps(feed);
        if (feed.Query.Length != 0 || !feed.AbsolutePath.EndsWith('/'))
            throw new InvalidDataException("Release feed must be an HTTPS directory URI without a query.");
        foreach (var host in AllowedRedirectHosts)
        {
            if (string.IsNullOrWhiteSpace(host) || host != host.Trim() || host.Contains('*')
                || Uri.CheckHostName(host) == UriHostNameType.Unknown
                || !string.Equals(ParseUri("https://" + host + "/").IdnHost, host, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Redirect hosts must be exact ASCII DNS names or IP addresses, without a port.");
        }
    }

    internal Uri ValidateFeed(string value)
    {
        var uri = ParseUri(value);
        if (IsRelease)
        {
            ValidateHttps(uri);
            if (uri.AbsoluteUri != ParseUri(FeedUri).AbsoluteUri)
                throw new InvalidDataException("Feed differs from the embedded release policy.");
        }
        else if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.UserInfo.Length != 0
            || uri.Query.Length != 0 || uri.Fragment.Length != 0 || !uri.AbsolutePath.EndsWith('/'))
            throw new InvalidDataException("Development feed must be http://127.0.0.1:<port>/ with a trailing slash.");
        return uri;
    }

    internal void ValidateIdentity(Manifest manifest)
    {
        if (manifest.Schema != Schema || manifest.Product != Product || manifest.Channel != Channel || manifest.Platform != Platform)
            throw new InvalidDataException("Wrong manifest product, schema, channel or platform.");
        ValidatePackageUrl(manifest.PackageUrl);
    }

    internal void ValidatePackageUrl(string? packageUrl)
    {
        if (packageUrl is not null)
        {
            if (!IsRelease) throw new InvalidDataException("Development manifests cannot override the package URI.");
            ValidateRequest(ParseUri(packageUrl));
        }
    }

    internal Uri PackageUri(Uri feed, Manifest manifest)
    {
        ValidateFeed(feed.AbsoluteUri);
        ValidateIdentity(manifest);
        var uri = manifest.PackageUrl is null ? new Uri(feed, manifest.Package) : ParseUri(manifest.PackageUrl);
        ValidateRequest(uri);
        return uri;
    }

    internal void ValidateRequest(Uri uri)
    {
        if (!uri.IsAbsoluteUri) throw new InvalidDataException("Absolute download URI required.");
        if (IsRelease)
        {
            ValidateHttps(uri);
            if (!string.Equals(uri.IdnHost, ParseUri(FeedUri).IdnHost, StringComparison.OrdinalIgnoreCase)
                && !AllowedRedirectHosts.Contains(uri.IdnHost, StringComparer.OrdinalIgnoreCase))
                throw new InvalidDataException("Download host is not allowed by the embedded release policy.");
        }
        else if (uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.UserInfo.Length != 0
            || uri.Fragment.Length != 0 || uri.Query.Length != 0)
            throw new InvalidDataException("Development downloads require the loopback HTTP feed.");
    }

    internal static Uri ParseUri(string? value)
    {
        if (value is null || value != value.Trim() || value.Any(char.IsControl) || value.Contains('\\')
            || !Uri.TryCreate(value, UriKind.Absolute, out var uri))
            throw new InvalidDataException("Invalid download URI.");
        return uri;
    }

    static void ValidateHttps(Uri uri)
    {
        if (uri.Scheme != "https" || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0)
            throw new InvalidDataException("Release downloads require HTTPS without user information or fragments.");
    }
}

internal static partial class Program
{
    static void ValidateReleasePrivateKey(string path, params string[] distributionDirectories)
    {
        NoLinks(path);
        foreach (var directory in distributionDirectories)
            if (path.StartsWith(Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Release private key must be outside payload and feed directories.");
        for (var directory = Path.GetDirectoryName(path); directory is not null; directory = Path.GetDirectoryName(directory))
            if (Directory.Exists(Path.Combine(directory, ".git")) || File.Exists(Path.Combine(directory, ".git")))
                throw new InvalidDataException("Release private key must be outside source repositories.");
    }

    // Diagnostics must never persist signed CDN query credentials.
    static string SafeError(Exception error) => DiagnosticUri().Replace(error.Message, "[redacted URI]");

    [GeneratedRegex(@"https?://[^\s\""<>]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DiagnosticUri();
}
