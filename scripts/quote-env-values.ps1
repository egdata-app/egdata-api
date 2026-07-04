<#
.SYNOPSIS
Quotes values in dotenv-style KEY=value text.

.EXAMPLE
.\scripts\quote-env-values.ps1 -Path .env

.EXAMPLE
Get-Content .env | .\scripts\quote-env-values.ps1 -ToClipboard
#>

[CmdletBinding()]
param(
  [string]$Path,
  [string]$Text,
  [Parameter(ValueFromPipeline = $true)]
  [AllowEmptyString()]
  [string]$InputObject,
  [switch]$ToClipboard,
  [string]$EndMarker = "__END__"
)

begin {
  $pipelineLines = [System.Collections.Generic.List[string]]::new()
}

process {
  if ($PSBoundParameters.ContainsKey("InputObject")) {
    $pipelineLines.Add($InputObject)
  }
}

end {
  function Get-InteractiveEnvText {
    Write-Host "Paste env text below. Enter $EndMarker on a line by itself when done."

    $lines = [System.Collections.Generic.List[string]]::new()
    while ($true) {
      $line = Read-Host
      if ($line -eq $EndMarker) {
        break
      }

      $lines.Add($line)
    }

    return $lines -join [Environment]::NewLine
  }

  function Quote-EnvValue {
    param([string]$Value)

    $trimmedValue = $Value.Trim()
    if (
      ($trimmedValue.StartsWith("'") -and $trimmedValue.EndsWith("'")) -or
      ($trimmedValue.StartsWith('"') -and $trimmedValue.EndsWith('"'))
    ) {
      return $trimmedValue
    }

    $escapedValue = $trimmedValue.Replace("'", "\'")
    return "'$escapedValue'"
  }

  function ConvertTo-QuotedEnvText {
    param([string]$InputText)

    $lines = $InputText -split "\r?\n"
    $convertedLines = foreach ($line in $lines) {
      if ($line -match "^\s*$" -or $line -match "^\s*#") {
        $line
        continue
      }

      if ($line -match "^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$") {
        $prefix = $Matches[1]
        $value = $Matches[2]
        "$prefix$(Quote-EnvValue -Value $value)"
        continue
      }

      $line
    }

    return $convertedLines -join [Environment]::NewLine
  }

  if ($Path) {
    $rawText = Get-Content -LiteralPath $Path -Raw
  } elseif ($PSBoundParameters.ContainsKey("Text")) {
    $rawText = $Text
  } elseif ($pipelineLines.Count -gt 0) {
    $rawText = $pipelineLines -join [Environment]::NewLine
  } else {
    $rawText = Get-InteractiveEnvText
  }

  $result = ConvertTo-QuotedEnvText -InputText $rawText

  if ($ToClipboard) {
    Set-Clipboard -Value $result
  }

  Write-Output $result
}
