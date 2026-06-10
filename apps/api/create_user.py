"""
Script one-shot per creare l'account admin.
Esegui UNA sola volta, poi puoi cancellare questo file.

Usage:
    python3 apps/api/create_user.py
"""
import getpass
import sys

try:
    import bcrypt
except ImportError:
    sys.exit("Installa bcrypt: pip3 install bcrypt")

print("=== Creazione account Quantum Trade ===\n")
username = input("Username: ").strip()
if not username:
    sys.exit("Username non può essere vuoto.")

password = getpass.getpass("Password: ")
if len(password) < 8:
    sys.exit("La password deve essere di almeno 8 caratteri.")
confirm = getpass.getpass("Conferma password: ")
if password != confirm:
    sys.exit("Le password non corrispondono.")

hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

print("\n✅ Hash generato con successo.\n")
print("Esegui questo SQL nell'editor di Supabase (SQL Editor → New query):\n")
print("─" * 60)
print(f"INSERT INTO users (username, password_hash, is_active)")
print(f"VALUES ('{username}', '{hashed}', true);")
print("─" * 60)
print("\nDopo aver eseguito il SQL puoi cancellare questo file.")
