# Create users

Create a user by sending a `POST` request to the `/users` endpoint.

## Endpoint

- **Method:** `POST`
- **URL:** `http://localhost:4000/users` (use your server port if different)
- **Content-Type:** `application/json`

## Request body

| Field     | Type   | Required | Description   |
|----------|--------|----------|---------------|
| fullName | string | No       | User's name   |
| phone    | string | No       | Phone number  |

Both fields are optional; omitted fields are stored as `null`.

## JSON body (copy and paste)

Use this in Postman, Insomnia, or any HTTP client as the raw JSON body:

```json
{
  "fullName": "Jane Doe",
  "phone": "+1234567890"
}
```

## Examples

### cURL

```bash
curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"fullName": "Jane Doe", "phone": "+1234567890"}'
```

### PowerShell

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/users" -Method Post -ContentType "application/json" -Body '{"fullName": "Jane Doe", "phone": "+1234567890"}'
```

### Response (201 Created)

```json
{
  "id": 1,
  "fullName": "Jane Doe",
  "phone": "+1234567890"
}
```

Make sure the server is running (`npm run dev` or `npm start`) before sending requests.
