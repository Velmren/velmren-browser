[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateSet('protect','unprotect','directory')][string]$Mode,
 [string]$Directory
)
$ErrorActionPreference='Stop'
$data=$null
$result=$null
try {
 if($Mode -eq 'directory'){
  $item=Get-Item -LiteralPath $Directory
  if(!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid directory'}
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  foreach($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){
   $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit, ObjectInherit','None','Allow')))
  }
  # Persist only the DACL. Set-Acl also attempts SACL access on protected directories.
  [IO.Directory]::SetAccessControl($item.FullName,$acl)
  [Console]::Out.Write('ok')
 } else {
  Add-Type -AssemblyName System.Security
  $inputText=[Console]::In.ReadToEnd()
  if($inputText.Length -gt 16384){throw 'Input too large'}
  $data=[Convert]::FromBase64String($inputText)
  $inputText=$null
  if($Mode -eq 'protect'){
   $result=[Security.Cryptography.ProtectedData]::Protect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  }else{
   $result=[Security.Cryptography.ProtectedData]::Unprotect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  }
  [Console]::Out.Write([Convert]::ToBase64String($result))
 }
}catch{
 [Console]::Error.Write('Local credential protection is unavailable.')
 exit 1
}finally{
 if($data){[Array]::Clear($data,0,$data.Length)}
 if($result){[Array]::Clear($result,0,$result.Length)}
}
