#!/usr/bin/env bash
# Reintenta un comando con backoff exponencial.
#
# Los pasos de subida del reingest (vectorize upsert, kv bulk put, r2 put) le
# pegan a la API de Cloudflare con cargas grandes — el bulk de ~54k claves a KV
# provoca 524/5xx transitorios cuando la API tarda en procesar un sub-lote — y
# wrangler sale con código !=0. Como las tres subidas son idempotentes (upsert
# por clave/id), reintentar el comando completo es seguro: wrangler reenvía todo
# desde cero, pero el resultado final es el mismo.
#
#   scripts/with-retry.sh <comando> [args...]
set -uo pipefail

max_intentos=5
espera=10                 # segundos; se duplica en cada reintento

intento=1
while true; do
  "$@" && exit 0
  codigo=$?
  if [ "$intento" -ge "$max_intentos" ]; then
    echo "✗ '$*' falló tras $max_intentos intentos (último código $codigo)" >&2
    exit "$codigo"
  fi
  echo "⚠ '$*' falló (código $codigo); reintento $intento/$((max_intentos - 1)) en ${espera}s…" >&2
  sleep "$espera"
  espera=$((espera * 2))
  intento=$((intento + 1))
done
