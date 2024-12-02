# Copyright (c) 2024, erpcloud.systems and contributors
# For license information, please see license.txt

import frappe
from frappe import _, scrub
from erpnext.accounts.utils import get_balance_on


cheque_status = [
    "حافظة شيكات واردة",
    "تحت التحصيل",
    "مرفوض بالبنك",
    "حافظة شيكات مرجعة"
]


def execute(filters=None):
	if filters.from_date > filters.to_date:
		frappe.throw(_("From Date must be before To Date"))

	columns = get_columns()
	data = []

	customers = get_customers(filters)
	for cust in customers:
		total_cheques = 0.0
		customer_balance = get_balance_on(
				party_type="Customer",
				party=cust.party,
				date=filters.to_date,
				start_date=filters.from_date
			)
		row = {
			"party": cust.party,
			"party_name": cust.party_name,
			"customer_balance": customer_balance
		}

		for status in cheque_status:
			amount = get_cheques_amount(filters, cust.party, status)
			row[scrub(status)] = amount
			total_cheques += amount

		row["no_of_cheques"] = get_no_of_cheques(filters, cust.party)
		row["balance"] = total_cheques + customer_balance

		data.append(row)

	return columns, data


def get_customers(filters):
	customer_filters = {
		"party_type": "Customer"
	}
	if filters.get("customers"):
		customer_filters["party"] = ["in", filters.get("customers")]

	return frappe.db.get_all("Payment Entry", filters=customer_filters, fields=["party", "party_name"], group_by="party")


def get_cheques_amount(filters, customer, status):
    amount = frappe.db.sql(
        """
        SELECT SUM(paid_amount) 
        FROM `tabPayment Entry`
        WHERE docstatus = 1 
        AND party_type = 'Customer'
        AND party = %(customer)s 
        AND cheque_status = %(status)s
        AND posting_date BETWEEN %(from_date)s AND %(to_date)s
        """,
        {
            "customer": customer,
            "status": status,
            "from_date": filters.from_date,
            "to_date": filters.to_date
        },
    )
    
    return amount and amount[0][0] or 0


def get_no_of_cheques(filters, customer):
	return frappe.db.count("Payment Entry", {
		"docstatus": 1,
		"party_type": "Customer",
		"party": customer,
		"cheque_status": ["IN", cheque_status],
		"posting_date": ["BETWEEN", (filters.from_date, filters.to_date)]
	})


def get_columns():
	columns = [
		{
			"label": _("Customer"),
			"fieldname": "party",
			"fieldtype": "Link",
			"options": "Customer",
			"width": 160
		},
		{
			"label": _("Customer Name"),
			"fieldname": "party_name",
			"fieldtype": "Data",
			"width": 200
		},
		{
			"label": _("Customer Balance"),
			"fieldname": "customer_balance",
			"fieldtype": "Currency",
			"width": 160
		}
	]


	for status in cheque_status:
		columns.append(
			{
				"label": _(status),
				"fieldname": scrub(status),
				"fieldtype": "Currency",
				"width": 160
			}
		)

	columns.extend([
		{
			"label": _("Number of Cheques"),
			"fieldname": "no_of_cheques",
			"fieldtype": "Int",
			"width": 160
		},
		{
			"label": _("Balance"),
			"fieldname": "balance",
			"fieldtype": "Currency",
			"width": 160
		}
	])

	return columns