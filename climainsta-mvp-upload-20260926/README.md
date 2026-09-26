# Conexiones del MVP de Climainsta

La aplicación está preparada para conectar cuatro servicios, sin guardar claves dentro del código visible:

1. **Base de datos**: avisos, usuarios, técnicos, estados, facturas y valoraciones.
2. **Telegram**: publicación del aviso y recepción de tiempos de los técnicos.
3. **Stripe**: pago de 69/75 €, confirmación y liquidaciones posteriores.
4. **Correo**: avisos al cliente y al técnico.

El archivo `.env.example` contiene únicamente nombres de configuración. Las claves reales deberán configurarse de forma privada cuando se creen las cuentas de prueba.

## Orden recomendado

1. Base de datos y usuarios.
2. Telegram en un grupo de prueba.
3. Stripe en modo prueba.
4. Gmail o correo del dominio.
5. Activación de producción después de probar cancelaciones, pagos caducados y facturas.
