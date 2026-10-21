# Diagnóstico y corrección: cancelación y pagos

## Diagnóstico

El pago bloqueaba la fila del pedido con `FOR UPDATE`, pero la cancelación leía el pedido y
el producto sin bloqueos. En una carrera, la cancelación podía calcular un total con el monto
cobrado anterior, o persistir el estado cancelado antes de que `recompute_totals` detectara
que el nuevo total era menor al pagado. La restricción `ck_order_money` prevenía datos
inválidos, pero la carrera podía terminar en error SQL en lugar de una respuesta controlada.
Además, la cancelación no rechazaba explícitamente pedidos `PAID` y `CLOSED`.

## Cambio

Pago y cancelación ahora adquieren bloqueos PostgreSQL en el mismo orden:

1. Fila del turno (`FOR UPDATE`).
2. Fila del pedido (`FOR UPDATE`, recargada desde PostgreSQL).
3. Para cancelación, fila del producto (`FOR UPDATE`).

Ese orden también coincide con el cierre del turno, que bloquea primero el turno y después
los pedidos. La cancelación valida estado y calcula el total resultante antes de modificar
filas. Estados `PAID` y `CLOSED` producen HTTP 409; con pagos parciales solo se acepta si el
nuevo total es mayor o igual al monto cobrado. Cualquier error deja que la transacción se
revierta íntegramente, incluido el registro de idempotencia y la auditoría. Los eventos de
pago/cancelación se publican después del commit; los reintentos con la misma clave devuelven
la respuesta guardada sin repetir la mutación.

No se cambiaron restricciones SQL ni el esquema de las respuestas API. Las pruebas usan
exclusivamente la base PostgreSQL local dedicada `restaurante_test` (puerto 5433) y no
realizan llamadas de escritura a Supabase.
